import { Pool } from 'mysql2/promise';

export interface Dispatch {
  order_id: string;
  dispatched_at?: Date;
}

export class ShippingService {
  constructor(private readonly db: Pool) {}

  /**
   * Helper to execute queries on the isolated shipping database.
   */
  private async query<T>(sql: string, params: any[]): Promise<T> {
    const [results] = await this.db.execute(sql, params);
    return results as T;
  }

  /**
   * Check if a dispatch entry already exists for an order.
   */
  async getDispatch(orderId: string): Promise<Dispatch | null> {
    const rows = await this.query<Dispatch[]>('SELECT * FROM dispatches WHERE order_id = ?', [orderId]);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Idempotent Order Dispatch.
   * J2: Exactly one dispatch per order.
   */
  async dispatchOrder(orderId: string): Promise<Dispatch> {
    // 1. Check if the dispatch record already exists (Idempotency)
    const existing = await this.getDispatch(orderId);
    if (existing) {
      console.log(`[ShippingService] Idempotent hit: Order ${orderId} already dispatched.`);
      return existing;
    }

    // 2. Write the dispatch entry.
    // Unique primary key constraint prevents duplicate insertion.
    try {
      await this.query('INSERT INTO dispatches (order_id) VALUES (?)', [orderId]);
      console.log(`[ShippingService] Dispatch entry created for order ${orderId}.`);
      return {
        order_id: orderId
      };
    } catch (err: any) {
      // If a concurrent thread inserted it, handle the duplicate key error gracefully
      if (err.code === 'ER_DUP_ENTRY') {
        console.log(`[ShippingService] Concurrent insert caught. Idempotent success for order ${orderId}.`);
        return { order_id: orderId };
      }
      console.error(`[ShippingService] Failed to dispatch order ${orderId}. Error: ${err.message}`);
      throw err;
    }
  }
}
