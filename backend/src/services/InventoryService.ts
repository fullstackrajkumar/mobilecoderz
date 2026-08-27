import { Pool } from 'mysql2/promise';

export interface Reservation {
  order_id: string;
  sku: string;
  qty: number;
  status: string;
  comp_fail_at?: string;
  created_at?: Date;
  updated_at?: Date;
}

export interface InventoryItem {
  sku: string;
  available_qty: number;
}

export class InventoryService {
  constructor(private readonly db: Pool) {}

  /**
   * Helper to execute queries on the isolated inventory database.
   */
  private async query<T>(sql: string, params: any[]): Promise<T> {
    const [results] = await this.db.execute(sql, params);
    return results as T;
  }

  /**
   * Seed the inventory if it's currently empty.
   */
  async seedInventory(items: InventoryItem[]): Promise<void> {
    const rows = await this.query<any[]>('SELECT COUNT(*) as count FROM inventory', []);
    const count = rows[0]?.count || 0;

    if (count > 0) {
      console.log('[InventoryService] Inventory already seeded.');
      return;
    }

    console.log(`[InventoryService] Seeding ${items.length} items into inventory...`);
    for (const item of items) {
      await this.query('INSERT INTO inventory (sku, available_qty) VALUES (?, ?) ON DUPLICATE KEY UPDATE available_qty = ?', [
        item.sku,
        item.available_qty,
        item.available_qty
      ]);
    }
    console.log('[InventoryService] Seeding complete.');
  }

  /**
   * Fetch inventory details for a SKU.
   */
  async getInventoryItem(sku: string): Promise<InventoryItem | null> {
    const rows = await this.query<InventoryItem[]>('SELECT * FROM inventory WHERE sku = ?', [sku]);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Fetch reservation by orderId.
   */
  async getReservation(orderId: string): Promise<Reservation | null> {
    const rows = await this.query<Reservation[]>('SELECT * FROM stock_reservations WHERE order_id = ?', [orderId]);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Idempotent Stock Reservation.
   * R1: Attempted in parallel with order creation.
   * R5: Never do a step twice.
   */
  async reserveStock(
    orderId: string,
    sku: string,
    qty: number,
    failAt?: string,
    compFailAt?: string
  ): Promise<Reservation> {
    // 1. Check if reservation already exists (Idempotency)
    const existing = await this.getReservation(orderId);
    if (existing) {
      console.log(`[InventoryService] Idempotent hit: Reservation for order ${orderId} already exists (status: ${existing.status}).`);
      if (existing.status === 'RELEASED') {
        throw new Error(`Cannot reserve stock for order ${orderId}: Reservation was already released.`);
      }
      return existing;
    }

    // 2. Simulate failure if requested by fail_at
    if (failAt === 'inventory') {
      console.error(`[InventoryService] Simulated reservation failure for order: ${orderId}`);
      throw new Error(`Simulated inventory reservation failure for order: ${orderId}`);
    }

    // 3. Perform atomic reservation in a transaction
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();

      // Get current stock with locking
      const [invRows]: any = await conn.execute(
        'SELECT available_qty FROM inventory WHERE sku = ? FOR UPDATE',
        [sku]
      );

      if (invRows.length === 0) {
        throw new Error(`SKU ${sku} not found in inventory.`);
      }

      const available = invRows[0].available_qty;
      if (available < qty) {
        throw new Error(`Insufficient stock for SKU ${sku}. Available: ${available}, Requested: ${qty}`);
      }

      // Deduct stock
      await conn.execute(
        'UPDATE inventory SET available_qty = available_qty - ? WHERE sku = ?',
        [qty, sku]
      );

      // Record reservation
      await conn.execute(
        'INSERT INTO stock_reservations (order_id, sku, qty, status, comp_fail_at) VALUES (?, ?, ?, "RESERVED", ?)',
        [orderId, sku, qty, compFailAt || null]
      );

      await conn.commit();
      console.log(`[InventoryService] Successfully reserved ${qty} of ${sku} for order ${orderId}.`);

      return {
        order_id: orderId,
        sku,
        qty,
        status: 'RESERVED',
        comp_fail_at: compFailAt
      };
    } catch (err: any) {
      await conn.rollback();
      console.error(`[InventoryService] Reservation failed for order ${orderId}. Rollback completed. Error: ${err.message}`);
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Idempotent Stock Release (Undo/Compensation).
   * R3: Undo on failure.
   * R5: Never do a step twice.
   */
  async releaseStock(orderId: string): Promise<void> {
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();

      // Fetch the reservation with lock
      const [resRows]: any = await conn.execute(
        'SELECT * FROM stock_reservations WHERE order_id = ? FOR UPDATE',
        [orderId]
      );

      if (resRows.length === 0) {
        console.log(`[InventoryService] No reservation found for order ${orderId}. Release is idempotent success.`);
        await conn.commit();
        return;
      }

      const reservation = resRows[0] as Reservation;

      if (reservation.status === 'RELEASED') {
        console.log(`[InventoryService] Idempotent hit: Reservation for order ${orderId} already RELEASED.`);
        await conn.commit();
        return;
      }

      // Simulate compensation failure if requested by comp_fail_at
      if (reservation.comp_fail_at === 'inventory') {
        console.error(`[InventoryService] Simulated compensation failure for order: ${orderId}`);
        throw new Error(`Simulated inventory compensation failure for order: ${orderId}`);
      }

      // Restore stock
      await conn.execute(
        'UPDATE inventory SET available_qty = available_qty + ? WHERE sku = ?',
        [reservation.qty, reservation.sku]
      );

      // Update reservation status
      await conn.execute(
        'UPDATE stock_reservations SET status = "RELEASED" WHERE order_id = ?',
        [orderId]
      );

      await conn.commit();
      console.log(`[InventoryService] Successfully released stock for order ${orderId}.`);
    } catch (err: any) {
      await conn.rollback();
      console.error(`[InventoryService] Release failed for order ${orderId}. Rollback completed. Error: ${err.message}`);
      throw err;
    } finally {
      conn.release();
    }
  }
}
