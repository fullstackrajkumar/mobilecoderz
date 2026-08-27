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
import { ShippingJob } from './coordinator/ShippingJob';

async function runTests() {
  console.log('=====================================================');
  console.log('            SAGA COORDINATOR TEST SUITE              ');
  console.log('=====================================================');

  try {
    // 1. Verify connections
    await testDbConnections();

    // 2. Instantiate services
    const orderService = new OrderService(orderPool);
    const inventoryService = new InventoryService(inventoryPool);
    const shippingService = new ShippingService(shippingPool);
    const coordinator = new SagaCoordinator(orderService, inventoryService, shippingService, coordinatorPool);
    const shippingJob = new ShippingJob(shippingService, orderService, coordinatorPool);

    // -------------------------------------------------------------
    // SETUP: Clean tables & seed test SKU
    // -------------------------------------------------------------
    console.log('\n[Setup] Cleaning database tables...');
    await orderPool.execute('DELETE FROM orders');
    await inventoryPool.execute('DELETE FROM stock_reservations');
    await inventoryPool.execute('DELETE FROM inventory');
    await shippingPool.execute('DELETE FROM dispatches');
    await coordinatorPool.execute('DELETE FROM coordinator_orders');
    await coordinatorPool.execute('DELETE FROM coordinator_logs');

    console.log('[Setup] Seeding test inventory items...');
    await inventoryService.seedInventory([
      { sku: 'TEST-SKU-1', available_qty: 100 },
      { sku: 'TEST-SKU-2', available_qty: 100 }
    ]);

    // -------------------------------------------------------------
    // TEST 1 (T1): Both steps succeed -> Placed
    // -------------------------------------------------------------
    console.log('\n-----------------------------------------------------');
    console.log('TEST 1 (T1): Both steps succeed -> Placed');
    console.log('-----------------------------------------------------');

    const orderId1 = 'T1_ORD_001';
    await coordinator.processOrder(orderId1, 'TEST-SKU-1', 5, 500);

    // Verify
    const order1 = await orderService.getOrder(orderId1);
    const reservation1 = await inventoryService.getReservation(orderId1);
    const coordOrder1 = await coordinator.getCoordinatorOrder(orderId1);
    const invItem1 = await inventoryService.getInventoryItem('TEST-SKU-1');

    console.log(`- Order Status in DB: ${order1?.status} (Expected: PLACED)`);
    console.log(`- Reservation Status in DB: ${reservation1?.status} (Expected: RESERVED)`);
    console.log(`- Coordinator Status: ${coordOrder1?.status} (Expected: PLACED)`);
    console.log(`- Remaining Stock: ${invItem1?.available_qty} (Expected: 95)`);

    if (
      order1?.status === 'PLACED' &&
      reservation1?.status === 'RESERVED' &&
      coordOrder1?.status === 'PLACED' &&
      invItem1?.available_qty === 95
    ) {
      console.log('✅ TEST 1 PASSED');
    } else {
      throw new Error('❌ TEST 1 FAILED');
    }

    // -------------------------------------------------------------
    // TEST 2 (T2): A step fails -> compensation -> Cancelled
    // -------------------------------------------------------------
    console.log('\n-----------------------------------------------------');
    console.log('TEST 2 (T2): A step fails -> completed step is undone -> Cancelled');
    console.log('-----------------------------------------------------');

    // We set failAt = 'inventory' so inventory reservation fails.
    // The order service step will succeed initially, then get undone.
    const orderId2 = 'T2_ORD_002';
    await coordinator.processOrder(orderId2, 'TEST-SKU-1', 10, 1000, 'inventory');

    // Verify
    const order2 = await orderService.getOrder(orderId2);
    const reservation2 = await inventoryService.getReservation(orderId2);
    const coordOrder2 = await coordinator.getCoordinatorOrder(orderId2);
    const invItem2 = await inventoryService.getInventoryItem('TEST-SKU-1');

    console.log(`- Order Status in DB: ${order2?.status} (Expected: CANCELLED)`);
    console.log(`- Reservation Record exists: ${!!reservation2} (Expected: false)`);
    console.log(`- Coordinator Status: ${coordOrder2?.status} (Expected: CANCELLED)`);
    console.log(`- Remaining Stock: ${invItem2?.available_qty} (Expected: 95)`);

    if (
      order2?.status === 'CANCELLED' &&
      !reservation2 &&
      coordOrder2?.status === 'CANCELLED' &&
      invItem2?.available_qty === 95
    ) {
      console.log('✅ TEST 2 PASSED');
    } else {
      throw new Error('❌ TEST 2 FAILED');
    }

    // -------------------------------------------------------------
    // TEST 3 (T3): Retry after slow reply -> Not executed twice (Idempotency)
    // -------------------------------------------------------------
    console.log('\n-----------------------------------------------------');
    console.log('TEST 3 (T3): Step retried after slow reply is not executed twice');
    console.log('-----------------------------------------------------');

    // To test idempotency, we call InventoryService.reserveStock twice.
    // The second call must see the reservation already exists and return success,
    // without deducting the stock a second time.
    const orderId3 = 'T3_ORD_003';
    const sku = 'TEST-SKU-2'; // Stock = 100
    
    console.log('- Performing first reservation...');
    await inventoryService.reserveStock(orderId3, sku, 10);
    const stockAfterFirst = (await inventoryService.getInventoryItem(sku))?.available_qty;
    console.log(`  Stock after first call: ${stockAfterFirst} (Expected: 90)`);

    console.log('- Performing second reservation (simulated retry/duplicate)...');
    await inventoryService.reserveStock(orderId3, sku, 10);
    const stockAfterSecond = (await inventoryService.getInventoryItem(sku))?.available_qty;
    console.log(`  Stock after second call: ${stockAfterSecond} (Expected: 90)`);

    if (stockAfterFirst === 90 && stockAfterSecond === 90) {
      console.log('✅ TEST 3 PASSED');
    } else {
      throw new Error('❌ TEST 3 FAILED');
    }

    // -------------------------------------------------------------
    // TEST 4 (T4): Exactly one dispatch per Placed order
    // -------------------------------------------------------------
    console.log('\n-----------------------------------------------------');
    console.log('TEST 4 (T4): Every Placed order ends with exactly one dispatch entry');
    console.log('-----------------------------------------------------');

    // We have T1_ORD_001 which is in status PLACED.
    // We will run the Shipping Job dispatch cycle twice and verify exactly one dispatch record is created.
    console.log('- Running shipping job cycle 1...');
    await shippingJob.runDispatchCycle();
    
    console.log('- Running shipping job cycle 2...');
    await shippingJob.runDispatchCycle();

    const dispatch = await shippingService.getDispatch(orderId1);
    const [dispatchesCountRows]: any = await shippingPool.execute(
      'SELECT COUNT(*) as count FROM dispatches WHERE order_id = ?',
      [orderId1]
    );
    const count = dispatchesCountRows[0].count;

    console.log(`- Dispatch record exists: ${!!dispatch} (Expected: true)`);
    console.log(`- Dispatch entries count in DB: ${count} (Expected: 1)`);

    const orderFinal1 = await orderService.getOrder(orderId1);
    const coordFinal1 = await coordinator.getCoordinatorOrder(orderId1);
    console.log(`- Order Status in DB: ${orderFinal1?.status} (Expected: SHIPPED)`);
    console.log(`- Coordinator Status: ${coordFinal1?.status} (Expected: SHIPPED)`);

    if (count === 1 && orderFinal1?.status === 'SHIPPED' && coordFinal1?.status === 'SHIPPED') {
      console.log('✅ TEST 4 PASSED');
    } else {
      throw new Error('❌ TEST 4 FAILED');
    }

    console.log('\n=====================================================');
    console.log('          🎉 ALL INTEGRATION TESTS PASSED 🎉         ');
    console.log('=====================================================');
    
    // Close pools so process terminates
    await orderPool.end();
    await inventoryPool.end();
    await shippingPool.end();
    await coordinatorPool.end();
    process.exit(0);

  } catch (err: any) {
    console.error(`\n❌ TEST SUITE RUN FAILED: ${err.message}`);
    // Ensure pools are closed
    await orderPool.end().catch(() => {});
    await inventoryPool.end().catch(() => {});
    await shippingPool.end().catch(() => {});
    await coordinatorPool.end().catch(() => {});
    process.exit(1);
  }
}

runTests();
