import { Pool, ResultSetHeader } from 'mysql2/promise';

export interface Order {
  order_id: string;
  sku: string;
  qty: number;
  amount: number;
  status: string;
  fail_at?: string;
  comp_fail_at?: string;
  created_at?: Date;
  updated_at?: Date;
}

export class OrderService {
  constructor(private readonly db: Pool) {}

  /**
   * Helper to execute queries on the isolated order database.
   */
  private async query<T>(sql: string, params: any[]): Promise<T> {
    const [results] = await this.db.execute(sql, params);
    return results as T;
  }

  /**
   * Get an order by its ID.
   */
  async getOrder(orderId: string): Promise<Order | null> {
    const rows = await this.query<Order[]>('SELECT * FROM orders WHERE order_id = ?', [orderId]);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Idempotent Order Creation.
   * R5: Never do a step twice.
   */
  async createOrder(
    orderId: string,
    sku: string,
    qty: number,
    amount: number,
    failAt?: string,
    compFailAt?: string
  ): Promise<Order> {
    // 1. Check if the order already exists
    const existing = await this.getOrder(orderId);
    if (existing) {
      console.log(`[OrderService] Idempotent hit: Order ${orderId} already exists.`);
      return existing;
    }

    // 2. Simulate failure if requested by fail_at
    if (failAt === 'order') {
      console.error(`[OrderService] Simulated failure: Order ${orderId} failed during creation.`);
      throw new Error(`Simulated order creation failure for order: ${orderId}`);
    }

    // 3. Create the order with CREATED status
    const status = 'CREATED';
    await this.query(
      'INSERT INTO orders (order_id, sku, qty, amount, status, fail_at, comp_fail_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [orderId, sku, qty, amount, status, failAt || null, compFailAt || null]
    );

    console.log(`[OrderService] Order ${orderId} created successfully.`);
    return {
      order_id: orderId,
      sku,
      qty,
      amount,
      status,
      fail_at: failAt,
      comp_fail_at: compFailAt
    };
  }

  /**
   * Idempotent Order Confirmation (Mark Placed).
   */
  async markPlaced(orderId: string): Promise<void> {
    const order = await this.getOrder(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found to mark as PLACED`);
    }

    if (order.status === 'PLACED') {
      return; // Already placed
    }

    await this.query('UPDATE orders SET status = "PLACED" WHERE order_id = ?', [orderId]);
    console.log(`[OrderService] Order ${orderId} marked as PLACED.`);
  }

  /**
   * Idempotent Order Shipped.
   */
  async markShipped(orderId: string): Promise<void> {
    const order = await this.getOrder(orderId);
    if (!order) {
      throw new Error(`Order ${orderId} not found to mark as SHIPPED`);
    }

    if (order.status === 'SHIPPED') {
      return; // Already shipped
    }

    await this.query('UPDATE orders SET status = "SHIPPED" WHERE order_id = ?', [orderId]);
    console.log(`[OrderService] Order ${orderId} marked as SHIPPED.`);
  }

  /**
   * Idempotent Order Cancellation (Compensation/Undo).
   * R3: Undo on failure.
   * R5: Never do a step twice.
   */
  async cancelOrder(orderId: string): Promise<void> {
    const order = await this.getOrder(orderId);
    if (!order) {
      // If the order was never created, cancellation is an idempotent success (nothing to undo)
      console.log(`[OrderService] Order ${orderId} does not exist. Cancellation is idempotent success.`);
      return;
    }

    if (order.status === 'CANCELLED') {
      console.log(`[OrderService] Idempotent hit: Order ${orderId} is already CANCELLED.`);
      return;
    }

    // Simulate compensation failure if requested by comp_fail_at
    if (order.comp_fail_at === 'order') {
      console.error(`[OrderService] Simulated compensation failure for order: ${orderId}`);
      throw new Error(`Simulated order compensation failure for order: ${orderId}`);
    }

    await this.query('UPDATE orders SET status = "CANCELLED" WHERE order_id = ?', [orderId]);
    console.log(`[OrderService] Order ${orderId} cancelled successfully.`);
  }
}
