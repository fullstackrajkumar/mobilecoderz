export class ConcurrencyQueue {
  private activeCount = 0;
  private queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  /**
   * Run an asynchronous task inside the concurrency queue, enforcing limits.
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      const next = this.queue.shift();
      if (next) next();
    }
  }

  /**
   * Get the current count of active tasks.
   */
  getActiveCount(): number {
    return this.activeCount;
  }

  /**
   * Get the count of pending tasks in the queue.
   */
  getQueueLength(): number {
    return this.queue.length;
  }
}
