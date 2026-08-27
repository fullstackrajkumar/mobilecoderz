import { Router } from 'express';
import { OrderController } from '../controllers/OrderController';

export function createOrderRouter(controller: OrderController): Router {
  const router = Router();

  router.get('/', (req, res) => controller.getOrders(req, res));
  router.get('/inventory', (req, res) => controller.getInventory(req, res));
  router.get('/stream/stats', (req, res) => controller.getStreamStats(req, res));
  router.post('/stream', (req, res) => controller.streamCsv(req, res));
  router.get('/:orderId/logs', (req, res) => controller.getOrderLogs(req, res));
  router.post('/retry/:orderId', (req, res) => controller.retryOrder(req, res));

  return router;
}
