-- Database creation
CREATE DATABASE IF NOT EXISTS order_db;
CREATE DATABASE IF NOT EXISTS inventory_db;
CREATE DATABASE IF NOT EXISTS shipping_db;
CREATE DATABASE IF NOT EXISTS coordinator_db;

-- -------------------------------------------------------------
-- Order DB Schema
-- -------------------------------------------------------------
USE order_db;

CREATE TABLE IF NOT EXISTS orders (
  order_id VARCHAR(255) PRIMARY KEY,
  sku VARCHAR(255) NOT NULL,
  qty INT NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  status VARCHAR(50) NOT NULL, -- CREATED, PLACED, CANCELLED
  fail_at VARCHAR(50) DEFAULT NULL,
  comp_fail_at VARCHAR(50) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------
-- Inventory DB Schema
-- -------------------------------------------------------------
USE inventory_db;

CREATE TABLE IF NOT EXISTS inventory (
  sku VARCHAR(255) PRIMARY KEY,
  available_qty INT NOT NULL
);

CREATE TABLE IF NOT EXISTS stock_reservations (
  order_id VARCHAR(255) PRIMARY KEY,
  sku VARCHAR(255) NOT NULL,
  qty INT NOT NULL,
  status VARCHAR(50) NOT NULL, -- RESERVED, RELEASED
  comp_fail_at VARCHAR(50) DEFAULT NULL, -- Stores simulated undo failures
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------
-- Shipping DB Schema
-- -------------------------------------------------------------
USE shipping_db;

CREATE TABLE IF NOT EXISTS dispatches (
  order_id VARCHAR(255) PRIMARY KEY,
  dispatched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------
-- Coordinator DB Schema
-- -------------------------------------------------------------
USE coordinator_db;

CREATE TABLE IF NOT EXISTS coordinator_orders (
  order_id VARCHAR(255) PRIMARY KEY,
  status VARCHAR(50) NOT NULL, -- IN_PROGRESS, PLACED, SHIPPED, CANCELLED, NEEDS_ATTENTION
  retry_count INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS coordinator_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id VARCHAR(255) NOT NULL,
  step VARCHAR(50) NOT NULL, -- ORDER_CREATE, INVENTORY_RESERVE, ORDER_CANCEL, INVENTORY_RELEASE
  action VARCHAR(50) NOT NULL, -- TRY, UNDO
  status VARCHAR(50) NOT NULL, -- SUCCESS, FAILED, TIMEOUT
  attempt INT NOT NULL,
  error_message TEXT DEFAULT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
