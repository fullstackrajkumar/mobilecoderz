import mysql from 'mysql2/promise';

const host = process.env.DB_HOST || 'localhost';
const user = process.env.DB_USER || 'root';
const password = process.env.DB_PASSWORD || 'rootpassword';
const port = parseInt(process.env.DB_PORT || '3306', 10);

export function createPool(database: string): mysql.Pool {
  return mysql.createPool({
    host,
    user,
    password,
    port,
    database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  });
}

// Independent pools representing distinct physical databases in production
export const orderPool = createPool('order_db');
export const inventoryPool = createPool('inventory_db');
export const shippingPool = createPool('shipping_db');
export const coordinatorPool = createPool('coordinator_db');

// Healthcheck function to make sure all schemas are reachable on startup
export async function testDbConnections(): Promise<void> {
  const pools = [
    { name: 'order_db', pool: orderPool },
    { name: 'inventory_db', pool: inventoryPool },
    { name: 'shipping_db', pool: shippingPool },
    { name: 'coordinator_db', pool: coordinatorPool }
  ];

  for (const item of pools) {
    try {
      const conn = await item.pool.getConnection();
      conn.release();
      console.log(`Successfully connected to database: ${item.name}`);
    } catch (err: any) {
      console.error(`Failed to connect to database: ${item.name}. Error: ${err.message}`);
      throw err;
    }
  }
}
