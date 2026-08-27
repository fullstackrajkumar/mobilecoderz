import fs from 'fs';
import csv from 'csv-parser';
import { InventoryItem } from '../services/InventoryService';

/**
 * Parse sample_inventory.csv file.
 */
export function parseInventoryCsv(filePath: string): Promise<InventoryItem[]> {
  return new Promise((resolve, reject) => {
    const items: InventoryItem[] = [];
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (row: any) => {
        const sku = row.sku?.trim();
        const available_qty = parseInt(row.available_qty, 10);
        if (sku && !isNaN(available_qty)) {
          items.push({ sku, available_qty });
        }
      })
      .on('end', () => resolve(items))
      .on('error', (err) => reject(err));
  });
}
