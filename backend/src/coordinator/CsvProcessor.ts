import fs from 'fs';
import csv from 'csv-parser';
import { SagaCoordinator } from './SagaCoordinator';
import { ConcurrencyQueue } from '../utils/ConcurrencyQueue';

export class CsvProcessor {
  private processingPromise: Promise<void> | null = null;
  private totalRows = 0;
  private skippedRows = 0;
  private processedRows = 0;
  private failedRows = 0;

  constructor(
    private readonly coordinator: SagaCoordinator,
    private readonly concurrencyLimit: number = 15
  ) {}

  /**
   * Stream and process the orders CSV file.
   * S1: Stream the file — never load it fully into memory.
   * S2: Concurrent orders — process many at the same time.
   */
  async processCsv(filePath: string): Promise<void> {
    if (this.processingPromise) {
      throw new Error('CSV processing is already in progress.');
    }

    this.totalRows = 0;
    this.skippedRows = 0;
    this.processedRows = 0;
    this.failedRows = 0;

    this.processingPromise = new Promise<void>((resolve, reject) => {
      if (!fs.existsSync(filePath)) {
        reject(new Error(`File not found: ${filePath}`));
        this.processingPromise = null;
        return;
      }

      const queue = new ConcurrencyQueue(this.concurrencyLimit);
      const readStream = fs.createReadStream(filePath);
      const csvStream = readStream.pipe(csv());

      let isPaused = false;

      csvStream.on('data', (row: any) => {
        this.totalRows++;
        const orderId = row.order_id?.trim();
        const sku = row.sku?.trim();
        const qty = parseInt(row.qty, 10);
        const amount = parseFloat(row.amount || '0');
        const failAt = row.fail_at?.trim() || undefined;
        const compFailAt = row.comp_fail_at?.trim() || undefined;

        if (!orderId || !sku || isNaN(qty)) {
          this.skippedRows++;
          return;
        }

        // Backpressure control: if queue is getting large, pause the CSV stream
        if (queue.getQueueLength() > this.concurrencyLimit * 2) {
          csvStream.pause();
          isPaused = true;
        }

        // Run the saga in the concurrency queue
        queue.run(async () => {
          try {
            const existing = await this.coordinator.getCoordinatorOrder(orderId);
            if (existing) {
              this.skippedRows++;
              return;
            }

            await this.coordinator.processOrder(orderId, sku, qty, amount, failAt, compFailAt);
            this.processedRows++;
          } catch (err: any) {
            console.error(`[CsvProcessor] Error processing order ${orderId}: ${err.message}`);
            this.failedRows++;
          } finally {
            // Resume stream if queue cleared up
            if (isPaused && queue.getQueueLength() <= this.concurrencyLimit) {
              csvStream.resume();
              isPaused = false;
            }
          }
        });
      });

      csvStream.on('end', async () => {
        // Wait for all remaining items in the queue to complete
        while (queue.getActiveCount() > 0 || queue.getQueueLength() > 0) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        console.log(
          `[CsvProcessor] Completed CSV processing: Total=${this.totalRows}, Processed=${this.processedRows}, Skipped=${this.skippedRows}, Failed=${this.failedRows}`
        );
        resolve();
        this.processingPromise = null;
      });

      csvStream.on('error', (err: any) => {
        console.error(`[CsvProcessor] Stream error: ${err.message}`);
        reject(err);
        this.processingPromise = null;
      });
    });

    return this.processingPromise;
  }

  /**
   * Get the current processing statistics.
   */
  getStats() {
    return {
      status: this.processingPromise ? 'PROCESSING' : 'IDLE',
      totalRows: this.totalRows,
      processedRows: this.processedRows,
      skippedRows: this.skippedRows,
      failedRows: this.failedRows
    };
  }
}
