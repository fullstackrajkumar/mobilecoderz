import express from 'express';
import cors from 'cors';
import path from 'path';
import {
  orderPool,
  inventoryPool,
  shippingPool,
  coordinatorPool,
  testDbConnections
} from './config/db';
import { OrderService } from './services/OrderService';
import { InventoryService } from './services/InventoryService';
import { ShippingService } from './services/ShippingService';
import { SagaCoordinator } from './coordinator/SagaCoordinator';
import { CsvProcessor } from './coordinator/CsvProcessor';
import { ShippingJob } from './coordinator/ShippingJob';
import { OrderController } from './controllers/OrderController';
import { createOrderRouter } from './routes/orderRoutes';
import { parseInventoryCsv } from './utils/csvHelper';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

async function bootstrap() {
  console.log('[Bootstrap] Starting Saga Orchestrator server...');

  try {
    // 1. Verify DB Connections (Healthcheck)
    await testDbConnections();

    // 2. Instantiate logical services with their respective isolated DB pools
    // Rule G1: Only a service touches its own schema.
    const orderService = new OrderService(orderPool);
    const inventoryService = new InventoryService(inventoryPool);
    const shippingService = new ShippingService(shippingPool);

    // 3. Seed inventory on startup if empty
    const inventoryCsvPath = path.resolve(__dirname, '../sample_inventory .csv');
    try {
      const items = await parseInventoryCsv(inventoryCsvPath);
      await inventoryService.seedInventory(items);
    } catch (csvErr: any) {
      console.error(`[Bootstrap] Error parsing inventory seed file: ${csvErr.message}`);
    }

    // 4. Instantiate Saga Coordinator (injecting services and coordinator DB)
    // Rule G2: Coordinator talks to services only through their APIs.
    const coordinator = new SagaCoordinator(orderService, inventoryService, shippingService, coordinatorPool);

    // 5. Instantiate CsvProcessor for bulk file streaming
    const csvProcessor = new CsvProcessor(coordinator, 15);

    // 6. Instantiate and start Background Shipping Dispatch Job
    // Demo: Runs every 5 seconds (configurable)
    const shippingJob = new ShippingJob(shippingService, orderService, coordinatorPool);
    shippingJob.start(5000);

    // 7. Restart Recovery
    // R6: Survive a restart. Resumes from where it left off.
    await coordinator.resumeIncompleteSagas();

    // 8. Instantiate controllers and routers (DIP)
    const orderController = new OrderController(coordinator, csvProcessor, coordinatorPool, inventoryPool);
    const orderRouter = createOrderRouter(orderController);

    // Register routes
    app.use('/api/orders', orderRouter);

    // Healthcheck endpoint
    app.get('/health', (req, res) => {
      res.json({ status: 'OK', timestamp: new Date() });
    });

    const server = app.listen(PORT, () => {
      console.log(`[Bootstrap] Express Server listening on port ${PORT}`);
    });

    // Graceful Shutdown
    const shutdown = async () => {
      console.log('[Bootstrap] Shutting down gracefully...');
      shippingJob.stop();
      server.close();
      
      // Close all pools
      await orderPool.end();
      await inventoryPool.end();
      await shippingPool.end();
      await coordinatorPool.end();
      console.log('[Bootstrap] All database pools closed. Exiting.');
      process.exit(0);
    };

    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);

  } catch (err: any) {
    console.error(`[Bootstrap] Fatal server initialization error: ${err.message}`);
    process.exit(1);
  }
}

bootstrap();
