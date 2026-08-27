import { Pool } from 'mysql2/promise';
import { OrderService } from '../services/OrderService';
import { InventoryService } from '../services/InventoryService';
import { ShippingService } from '../services/ShippingService';

export type SagaStatus = 'IN_PROGRESS' | 'PLACED' | 'SHIPPED' | 'CANCELLED' | 'NEEDS_ATTENTION';

export interface CoordinatorOrder {
  order_id: string;
  status: SagaStatus;
  retry_count: number;
  created_at?: Date;
  updated_at?: Date;
}

export class SagaCoordinator {
  constructor(
    private readonly orderService: OrderService,
    private readonly inventoryService: InventoryService,
    private readonly shippingService: ShippingService,
    private readonly db: Pool
  ) {}

  /**
   * Helper to execute queries on the isolated coordinator database.
   */
  private async query<T>(sql: string, params: any[]): Promise<T> {
    const [results] = await this.db.execute(sql, params);
    return results as T;
  }

  /**
   * Fetch a coordinator order state.
   */
  async getCoordinatorOrder(orderId: string): Promise<CoordinatorOrder | null> {
    const rows = await this.query<CoordinatorOrder[]>(
      'SELECT * FROM coordinator_orders WHERE order_id = ?',
      [orderId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Write an audit log entry for steps tracing.
   * R8: Clear record. Traceable start to finish.
   */
  async writeAuditLog(
    orderId: string,
    step: 'ORDER_CREATE' | 'INVENTORY_RESERVE' | 'ORDER_CANCEL' | 'INVENTORY_RELEASE',
    action: 'TRY' | 'UNDO',
    status: 'SUCCESS' | 'FAILED' | 'TIMEOUT',
    attempt: number,
    errorMessage?: string
  ): Promise<void> {
    await this.query(
      'INSERT INTO coordinator_logs (order_id, step, action, status, attempt, error_message) VALUES (?, ?, ?, ?, ?, ?)',
      [orderId, step, action, status, attempt, errorMessage || null]
    );
  }

  /**
   * Helper wrapper to enforce execution timeout.
   * R4: Each step has a 5-second limit; longer counts as failed.
   */
  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number = 5000): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('TIMEOUT'));
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer!);
    }
  }

  /**
   * Helper wrapper to execute service calls with retries and log tracing.
   * R4: Retry up to 3 times (total 4 attempts) with a 1-second wait.
   */
  private async runWithRetry<T>(
    orderId: string,
    step: 'ORDER_CREATE' | 'INVENTORY_RESERVE' | 'ORDER_CANCEL' | 'INVENTORY_RELEASE',
    action: 'TRY' | 'UNDO',
    fn: () => Promise<T>
  ): Promise<T> {
    const maxRetries = 3;
    let attempt = 1;

    while (true) {
      try {
        // Execute operation with timeout
        const result = await this.withTimeout(fn(), 5000);
        
        // Log success
        await this.writeAuditLog(orderId, step, action, 'SUCCESS', attempt);
        return result;
      } catch (err: any) {
        const isTimeout = err.message === 'TIMEOUT';
        const status = isTimeout ? 'TIMEOUT' : 'FAILED';
        const errMsg = err.message || 'Unknown error';

        console.warn(
          `[SagaCoordinator] Order ${orderId} | Step ${step} (${action}) attempt ${attempt} failed: ${errMsg}`
        );

        // Log failure
        await this.writeAuditLog(orderId, step, action, status, attempt, errMsg);

        if (attempt > maxRetries) {
          throw err; // Reached max attempts, propagate failure
        }

        // Wait 1 second before retry
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  /**
   * Start processing a new order from the CSV file.
   * S3: Reload safety - loading the same file again must not create duplicate orders.
   */
  async processOrder(
    orderId: string,
    sku: string,
    qty: number,
    amount: number,
    failAt?: string,
    compFailAt?: string
  ): Promise<void> {
    // 1. Check if the order has already been processed or is in progress
    const existing = await this.getCoordinatorOrder(orderId);
    if (existing) {
      console.log(`[SagaCoordinator] Reload safety check: Order ${orderId} already processed (Status: ${existing.status}). Skipping.`);
      return;
    }

    // 2. Initialize in database as IN_PROGRESS
    await this.query(
      'INSERT INTO coordinator_orders (order_id, status, retry_count) VALUES (?, "IN_PROGRESS", 0)',
      [orderId]
    );

    // 3. Execute Saga Orchestration
    await this.executeSaga(orderId, sku, qty, amount, failAt, compFailAt);
  }

  /**
   * Run the core Saga orchestration logic.
   */
  async executeSaga(
    orderId: string,
    sku: string,
    qty: number,
    amount: number,
    failAt?: string,
    compFailAt?: string
  ): Promise<void> {
    let orderCreated = false;
    let stockReserved = false;

    // R1: Parallel steps. Attempt both steps at the same time.
    try {
      await Promise.all([
        // Step 1: Create Order
        this.runWithRetry(orderId, 'ORDER_CREATE', 'TRY', () =>
          this.orderService.createOrder(orderId, sku, qty, amount, failAt, compFailAt)
        ).then(() => {
          orderCreated = true;
        }),

        // Step 2: Reserve Stock
        this.runWithRetry(orderId, 'INVENTORY_RESERVE', 'TRY', () =>
          this.inventoryService.reserveStock(orderId, sku, qty, failAt, compFailAt)
        ).then(() => {
          stockReserved = true;
        })
      ]);

      // R2: Placed. Both succeed -> the order ends Placed.
      await this.orderService.markPlaced(orderId);
      await this.query('UPDATE coordinator_orders SET status = "PLACED" WHERE order_id = ?', [orderId]);
      console.log(`[SagaCoordinator] Order ${orderId} completed successfully (Status: PLACED).`);
    } catch (err: any) {
      console.error(`[SagaCoordinator] Order ${orderId} execution failed. Initializing compensation. Error: ${err.message}`);
      
      // R3: Undo on failure. Either step fails -> undo the one that succeeded.
      await this.compensate(orderId, orderCreated, stockReserved);
    }
  }

  /**
   * Perform compensating steps (Undo transactions).
   * R3: Undo on failure.
   * R7: Undo can't finish -> NEEDS_ATTENTION.
   */
  private async compensate(orderId: string, undoOrder: boolean, undoInventory: boolean): Promise<void> {
    const compensations: Promise<void>[] = [];

    if (undoOrder) {
      compensations.push(
        this.runWithRetry(orderId, 'ORDER_CANCEL', 'UNDO', () =>
          this.orderService.cancelOrder(orderId)
        )
      );
    }

    if (undoInventory) {
      compensations.push(
        this.runWithRetry(orderId, 'INVENTORY_RELEASE', 'UNDO', () =>
          this.inventoryService.releaseStock(orderId)
        )
      );
    }

    try {
      if (compensations.length > 0) {
        await Promise.all(compensations);
      }
      
      // Compensation completed successfully
      await this.query('UPDATE coordinator_orders SET status = "CANCELLED" WHERE order_id = ?', [orderId]);
      console.log(`[SagaCoordinator] Compensation successful. Order ${orderId} marked as CANCELLED.`);
    } catch (compErr: any) {
      console.error(`[SagaCoordinator] Critical! Compensation failed for order ${orderId}: ${compErr.message}`);
      
      // R7: Undo can't finish -> NEEDS_ATTENTION
      await this.query(
        'UPDATE coordinator_orders SET status = "NEEDS_ATTENTION" WHERE order_id = ?',
        [orderId]
      );
    }
  }

  /**
   * Manual retry trigger for orders stuck in NEEDS_ATTENTION.
   * R7: Manual retry button in the web page.
   */
  async retryNeedsAttention(orderId: string): Promise<void> {
    const order = await this.getCoordinatorOrder(orderId);
    if (!order || order.status !== 'NEEDS_ATTENTION') {
      throw new Error(`Order ${orderId} is not in NEEDS_ATTENTION status.`);
    }

    console.log(`[SagaCoordinator] Manual retry triggered for order: ${orderId}`);

    // Increment retry count
    await this.query(
      'UPDATE coordinator_orders SET retry_count = retry_count + 1 WHERE order_id = ?',
      [orderId]
    );

    // Fetch states of order and reservation to know what needs compensation.
    const dbOrder = await this.orderService.getOrder(orderId);
    const dbReservation = await this.inventoryService.getReservation(orderId);

    const needsOrderCancel = dbOrder && dbOrder.status !== 'CANCELLED';
    const needsInventoryRelease = dbReservation && dbReservation.status !== 'RELEASED';

    // Trigger compensation again
    await this.compensate(orderId, !!needsOrderCancel, !!needsInventoryRelease);
  }

  /**
   * Restart Recovery Engine.
   * R6: Survive a restart. Continues from where it left off.
   */
  async resumeIncompleteSagas(): Promise<void> {
    console.log('[SagaCoordinator] Initializing Restart Recovery Engine...');

    // Fetch all orders that were left IN_PROGRESS
    const incompleteOrders = await this.query<CoordinatorOrder[]>(
      'SELECT * FROM coordinator_orders WHERE status = "IN_PROGRESS"',
      []
    );

    if (incompleteOrders.length === 0) {
      console.log('[SagaCoordinator] No incomplete orders found. Ready.');
      return;
    }

    console.log(`[SagaCoordinator] Found ${incompleteOrders.length} incomplete orders. Resuming...`);

    for (const order of incompleteOrders) {
      // Fetch details from order service
      const dbOrder = await this.orderService.getOrder(order.order_id);
      
      if (dbOrder) {
        // If order details exist in DB, re-execute the saga using the details
        // Idempotency in services will skip already executed parts.
        // We run these asynchronously so it doesn't block the startup sequence
        this.executeSaga(
          dbOrder.order_id,
          dbOrder.sku,
          dbOrder.qty,
          dbOrder.amount,
          dbOrder.fail_at,
          dbOrder.comp_fail_at
        ).catch((err) => {
          console.error(`[SagaCoordinator] Failed to resume order ${order.order_id}: ${err.message}`);
        });
      } else {
        // Order record was not created, meaning it crashed before OrderService.createOrder succeeded.
        // But since we don't have the original SKU/Qty in coordinator_orders, let's mark it as CANCELLED or check.
        // Wait, if it crashed before any forward step succeeded, we can just run compensate (which will release stock if reserved)
        // or mark it as CANCELLED since nothing was created.
        console.warn(`[SagaCoordinator] Order details not found for incomplete order: ${order.order_id}. Rollbacking.`);
        this.compensate(order.order_id, false, true).catch((err) => {
          console.error(`[SagaCoordinator] Failed to roll back orphan order ${order.order_id}: ${err.message}`);
        });
      }
    }
  }
}
