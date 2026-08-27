import { Pool } from 'mysql2/promise';
import { ShippingService } from '../services/ShippingService';
import { OrderService } from '../services/OrderService';

export class ShippingJob {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly shippingService: ShippingService,
    private readonly orderService: OrderService,
    private readonly coordinatorDb: Pool
  ) {}

  /**
   * Start the background scheduled job.
   * J1: On a schedule, find Placed orders not yet dispatched.
   * Configurable interval in milliseconds.
   */
  start(intervalMs: number = 5000): void {
    if (this.intervalId) {
      return;
    }

    console.log(`[ShippingJob] Scheduled dispatch job started. Interval: ${intervalMs / 1000}s`);
    this.intervalId = setInterval(async () => {
      await this.runDispatchCycle();
    }, intervalMs);
  }

  /**
   * Stop the scheduled job.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[ShippingJob] Scheduled dispatch job stopped.');
    }
  }

  /**
   * Run one cycle of shipping dispatch.
   * J2: Exactly one dispatch per order.
   * S4: Production ready (row locking ensures safety across instances).
   */
  async runDispatchCycle(): Promise<void> {
    if (this.isRunning) {
      return; // Prevent execution overlap
    }

    this.isRunning = true;
    const conn = await this.coordinatorDb.getConnection();
    try {
      await conn.beginTransaction();

      // 1. Fetch Placed orders with ROW LOCK.
      // If another instance of this job runs in parallel, it will wait here.
      const [placedOrders]: any = await conn.execute(
        'SELECT order_id FROM coordinator_orders WHERE status = "PLACED" FOR UPDATE'
      );

      if (placedOrders.length === 0) {
        await conn.commit();
        return;
      }

      console.log(`[ShippingJob] Found ${placedOrders.length} PLACED orders to dispatch.`);

      for (const row of placedOrders) {
        const orderId = row.order_id;
        try {
          // 2. Write dispatch entry (idempotent, checks and inserts row)
          await this.shippingService.dispatchOrder(orderId);

          // 3. Set order status to SHIPPED in Order Service (G1 isolation)
          await this.orderService.markShipped(orderId);

          // 4. Set status to SHIPPED in Coordinator
          await conn.execute(
            'UPDATE coordinator_orders SET status = "SHIPPED" WHERE order_id = ?',
            [orderId]
          );

          console.log(`[ShippingJob] Order ${orderId} successfully dispatched and marked SHIPPED.`);
        } catch (err: any) {
          console.error(`[ShippingJob] Failed to dispatch order ${orderId}: ${err.message}`);
          // We don't abort the entire job; other orders can still be processed.
          // The current row transaction state can be handled individually.
        }
      }

      await conn.commit();
    } catch (err: any) {
      await conn.rollback();
      console.error(`[ShippingJob] Error in dispatch cycle. Transaction rolled back. Error: ${err.message}`);
    } finally {
      conn.release();
      this.isRunning = false;
    }
  }
}
