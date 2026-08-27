# Saga Orchestrator — Order Processing System

A distributed transaction coordinator implementing the **Saga orchestrator pattern** with logical services (Order, Inventory, and Shipping), full idempotency, retry mechanisms, timeout controls, crash recovery, and a beautiful Angular dashboard.

---

## Technical Stack & Architecture
- **Frontend**: Angular 19 (Standalone component structure, signals for reactive state management, customized custom CSS dashboard).
- **Backend**: Node.js + TypeScript + Express (Logical service isolation, manual Dependency Injection at Composition Root, streaming CSV reader with backpressure concurrency queue).
- **Database**: MySQL (Logical isolation using four separate schemas: `order_db`, `inventory_db`, `shipping_db`, and `coordinator_db`).

---

## How to Run the Application

The application can be run either via **Docker Compose** or **Locally on the Host**.

### Option A: Local Run (Recommended for limited host disk space)

1. **Start the MySQL Database**:
   Make sure a MySQL instance is running on port `3306` (or start it in Docker):
   ```bash
   # Initialize schemas (Order, Inventory, Shipping, Coordinator)
   mysql -u root -prootpassword < init.sql
   ```
2. **Start the Backend**:
   ```bash
   cd backend
   npm install
   npm run dev
   ```
   *The server will start listening on port `3000` and automatically seed the inventory from `sample_inventory .csv`.*

3. **Start the Frontend**:
   ```bash
   cd frontend
   npm install
   npx ng serve
   ```
   *Open your browser at [http://localhost:4200](http://localhost:4200).*

---

### Option B: Run via Docker Compose

Build and launch the complete stack in containers:
```bash
docker-compose up --build -d
```
- **Frontend**: [http://localhost:4200](http://localhost:4200)
- **Backend**: [http://localhost:3000](http://localhost:3000)
- **MySQL**: port `3306`

---

## Running Integration Tests
We have built four integration tests mapping directly to the validation scenarios:
- **T1**: Both steps succeed $\rightarrow$ order reaches `PLACED` / `SHIPPED` status.
- **T2**: A step fails $\rightarrow$ completed step is undone $\rightarrow$ order reaches `CANCELLED` status.
- **T3**: Step retried after a slow reply is not executed twice (Idempotency).
- **T4**: Every `PLACED` order is dispatched exactly once by the Shipping job.

Run tests locally:
```bash
cd backend
npm run test
```

---

## Design Notes

### 1. Scale: Caching Idempotency
- **Fast Checks**: The "never do a step twice" verification stays fast by leveraging **unique database constraints** (Primary Keys on `order_id` in `orders` and `stock_reservations`). Database primary key checks are high-performance $O(1)$ B-tree index lookups.
- **Caching Strategy**: To scale further and avoid querying MySQL for every retry or duplicate message, we can cache step execution statuses in a distributed key-value store like **Redis**.
  - Cache key: `saga:order:<order_id>:step:<step_name>:success = true` (with a Time-to-Live of 24 hours).
  - **No Stale Cache**: In a Saga transaction, completed steps (e.g., `ORDER_CREATE` = `SUCCESS`) are **write-once (immutable)**. The status of a completed step never changes from success to failure. Thus, we write to the cache only after a database transaction successfully commits. There is no cache invalidation complexity because the cached states are read-only and immutable.

### 2. Multiple Instances: Concurrency in Production
- **What already stays correct**:
  - **Row Locks (`FOR UPDATE`)**: The Shipping dispatch job uses transaction row locks when fetching placed orders. If multiple coordinator instances run the background job concurrently, only one will acquire the lock on a row, dispatch it, and commit. The other instances will block, and once they get the lock, they will see the status is already `SHIPPED` and skip it.
  - **Idempotency**: If two coordinator instances attempt to run the same order concurrently (due to retries or network delays), database-level unique constraints will reject the second insert, forcing an idempotent success return.
- **What we would change for production**:
  - **Distributed Locks (Redlock)**: To prevent multiple coordinators from spending resources concurrently processing the same order, we can use a Redis-based distributed lock on the `order_id`. A coordinator must acquire `lock:order:<order_id>` before processing or roll-backing.
  - **Partitioned Message Broker (Kafka/RabbitMQ)**: In production, orders would be streamed into partitioned message broker queues. By partitioning the queue by `order_id`, we guarantee that all messages/events for a specific order are routed to the same coordinator instance, eliminating concurrent execution conflicts by design.
