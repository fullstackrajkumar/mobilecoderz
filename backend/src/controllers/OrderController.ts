import { Request, Response } from 'express';
import { Pool } from 'mysql2/promise';
import { SagaCoordinator } from '../coordinator/SagaCoordinator';
import { CsvProcessor } from '../coordinator/CsvProcessor';
import path from 'path';

export class OrderController {
  constructor(
    private readonly coordinator: SagaCoordinator,
    private readonly csvProcessor: CsvProcessor,
    private readonly coordinatorDb: Pool,
    private readonly inventoryDb: Pool
  ) {}

  /**
   * GET /api/orders
   * Paginated list of coordinator orders.
   */
  async getOrders(req: Request, res: Response): Promise<void> {
    try {
      const page = parseInt(req.query.page as string || '1', 10);
      const limit = parseInt(req.query.limit as string || '20', 10);
      const search = (req.query.search as string || '').trim();
      const status = (req.query.status as string || '').trim();
      
      const offset = (page - 1) * limit;

      let queryStr = 'SELECT * FROM coordinator_orders';
      let countStr = 'SELECT COUNT(*) as total FROM coordinator_orders';
      const params: any[] = [];
      const countParams: any[] = [];

      const conditions: string[] = [];
      if (search) {
        conditions.push('order_id LIKE ?');
        params.push(`%${search}%`);
        countParams.push(`%${search}%`);
      }
      if (status) {
        conditions.push('status = ?');
        params.push(status);
        countParams.push(status);
      }

      if (conditions.length > 0) {
        const whereClause = ' WHERE ' + conditions.join(' AND ');
        queryStr += whereClause;
        countStr += whereClause;
      }

      queryStr += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const [rows]: any = await this.coordinatorDb.execute(queryStr, params);
      const [countRows]: any = await this.coordinatorDb.execute(countStr, countParams);
      
      const total = countRows[0]?.total || 0;

      res.json({
        orders: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit)
        }
      });
    } catch (err: any) {
      console.error(`[OrderController] Error fetching orders: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch orders' });
    }
  }

  /**
   * GET /api/orders/:orderId/logs
   * Fetch audit logs trace for a specific order.
   */
  async getOrderLogs(req: Request, res: Response): Promise<void> {
    try {
      const { orderId } = req.params;
      const [rows]: any = await this.coordinatorDb.execute(
        'SELECT * FROM coordinator_logs WHERE order_id = ? ORDER BY timestamp ASC, id ASC',
        [orderId]
      );
      res.json(rows);
    } catch (err: any) {
      console.error(`[OrderController] Error fetching logs for order ${req.params.orderId}: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch order logs' });
    }
  }

  /**
   * POST /api/orders/retry/:orderId
   * Trigger manual retry of a failed compensation.
   */
  async retryOrder(req: Request, res: Response): Promise<void> {
    try {
      const { orderId } = req.params;
      await this.coordinator.retryNeedsAttention(orderId);
      res.json({ message: `Successfully triggered retry for order ${orderId}` });
    } catch (err: any) {
      console.error(`[OrderController] Error retrying order ${req.params.orderId}: ${err.message}`);
      res.status(400).json({ error: err.message || 'Failed to retry order' });
    }
  }

  /**
   * POST /api/orders/stream
   * Trigger bulk order CSV stream processing.
   */
  async streamCsv(req: Request, res: Response): Promise<void> {
    try {
      const stats = this.csvProcessor.getStats();
      if (stats.status === 'PROCESSING') {
        res.status(400).json({ error: 'CSV processing is already in progress' });
        return;
      }

      // Space in filename matching actual name
      const csvPath = path.resolve(__dirname, '../../orders_bulk .csv');
      
      // Run streaming asynchronously in background
      this.csvProcessor.processCsv(csvPath).catch((err) => {
        console.error(`[OrderController] Background CSV processing failed: ${err.message}`);
      });

      res.json({ message: 'CSV processing started in the background.' });
    } catch (err: any) {
      console.error(`[OrderController] Error starting CSV stream: ${err.message}`);
      res.status(500).json({ error: 'Failed to start CSV stream' });
    }
  }

  /**
   * GET /api/orders/stream/stats
   * Fetch CSV streaming statistics.
   */
  async getStreamStats(req: Request, res: Response): Promise<void> {
    res.json(this.csvProcessor.getStats());
  }

  /**
   * GET /api/inventory
   * Fetch inventory items.
   */
  async getInventory(req: Request, res: Response): Promise<void> {
    try {
      const [rows] = await this.inventoryDb.execute('SELECT * FROM inventory ORDER BY sku ASC');
      res.json(rows);
    } catch (err: any) {
      console.error(`[OrderController] Error fetching inventory: ${err.message}`);
      res.status(500).json({ error: 'Failed to fetch inventory' });
    }
  }
}
