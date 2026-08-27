import { Component, OnInit, OnDestroy, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

export interface Order {
  order_id: string;
  status: string;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: number;
  order_id: string;
  step: string;
  action: string;
  status: string;
  attempt: number;
  error_message: string | null;
  timestamp: string;
}

export interface InventoryItem {
  sku: string;
  available_qty: number;
}

export interface StreamStats {
  status: string;
  totalRows: number;
  processedRows: number;
  skippedRows: number;
  failedRows: number;
}

@Component({
  imports: [CommonModule, FormsModule],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
  standalone: true
})
export class App implements OnInit, OnDestroy {
  private readonly apiBase = 'http://localhost:3000/api/orders';
  private pollInterval: any;

  // Signals for state management
  protected readonly orders = signal<Order[]>([]);
  protected readonly totalOrders = signal(0);
  protected readonly page = signal(1);
  protected readonly totalPages = signal(1);
  protected readonly limit = signal(20);
  
  protected readonly search = signal('');
  protected readonly statusFilter = signal('');
  
  protected readonly inventory = signal<InventoryItem[]>([]);
  protected readonly selectedOrder = signal<Order | null>(null);
  protected readonly selectedOrderLogs = signal<AuditLog[]>([]);
  protected readonly streamStats = signal<StreamStats | null>(null);
  
  protected readonly errorMsg = signal<string | null>(null);
  protected readonly successMsg = signal<string | null>(null);
  protected readonly loading = signal(false);

  constructor(private readonly http: HttpClient) {}

  ngOnInit(): void {
    this.loadOrders();
    this.loadInventory();
    this.startPolling();
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  startPolling(): void {
    this.pollInterval = setInterval(() => {
      this.pollStreamStats();
      this.loadOrders(false); // Refresh silently without spinner
      this.loadInventory(false);
      
      // If we have a selected order, refresh its logs too
      const currentSelected = this.selectedOrder();
      if (currentSelected) {
        this.loadLogs(currentSelected, false);
      }
    }, 2000);
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }

  loadOrders(showSpinner = true): void {
    if (showSpinner) this.loading.set(true);
    
    const params: any = {
      page: this.page().toString(),
      limit: this.limit().toString()
    };

    if (this.search().trim()) {
      params.search = this.search().trim();
    }
    if (this.statusFilter()) {
      params.status = this.statusFilter();
    }

    this.http.get<any>(this.apiBase, { params }).subscribe({
      next: (res) => {
        this.orders.set(res.orders);
        this.totalOrders.set(res.pagination.total);
        this.totalPages.set(res.pagination.totalPages);
        this.loading.set(false);
      },
      error: (err) => {
        this.errorMsg.set('Failed to load orders.');
        this.loading.set(false);
      }
    });
  }

  loadInventory(showSpinner = true): void {
    this.http.get<InventoryItem[]>(`${this.apiBase}/inventory`).subscribe({
      next: (res) => {
        this.inventory.set(res);
      },
      error: (err) => {
        console.error('Failed to load inventory', err);
      }
    });
  }

  selectOrder(order: Order): void {
    this.selectedOrder.set(order);
    this.loadLogs(order);
  }

  closeDrawer(): void {
    this.selectedOrder.set(null);
    this.selectedOrderLogs.set([]);
  }

  loadLogs(order: Order, showSpinner = true): void {
    this.http.get<AuditLog[]>(`${this.apiBase}/${order.order_id}/logs`).subscribe({
      next: (res) => {
        this.selectedOrderLogs.set(res);
      },
      error: (err) => {
        console.error('Failed to load logs', err);
      }
    });
  }

  triggerStream(): void {
    this.loading.set(true);
    this.errorMsg.set(null);
    this.successMsg.set(null);

    this.http.post<any>(`${this.apiBase}/stream`, {}).subscribe({
      next: (res) => {
        this.successMsg.set(res.message);
        this.loading.set(false);
        this.loadOrders();
      },
      error: (err) => {
        this.errorMsg.set(err.error?.error || 'Failed to trigger stream.');
        this.loading.set(false);
      }
    });
  }

  pollStreamStats(): void {
    this.http.get<StreamStats>(`${this.apiBase}/stream/stats`).subscribe({
      next: (res) => {
        this.streamStats.set(res);
      },
      error: (err) => {
        console.error('Failed to fetch stream stats', err);
      }
    });
  }

  retryOrder(orderId: string): void {
    this.loading.set(true);
    this.errorMsg.set(null);
    this.successMsg.set(null);

    this.http.post<any>(`${this.apiBase}/retry/${orderId}`, {}).subscribe({
      next: (res) => {
        this.successMsg.set(res.message);
        this.loading.set(false);
        // Refresh the selected order state
        const currentSelected = this.selectedOrder();
        if (currentSelected && currentSelected.order_id === orderId) {
          this.loadLogs(currentSelected);
        }
        this.loadOrders();
      },
      error: (err) => {
        this.errorMsg.set(err.error?.error || 'Failed to retry compensation.');
        this.loading.set(false);
      }
    });
  }

  // Paging controls
  nextPage(): void {
    if (this.page() < this.totalPages()) {
      this.page.update((p) => p + 1);
      this.loadOrders();
    }
  }

  prevPage(): void {
    if (this.page() > 1) {
      this.page.update((p) => p - 1);
      this.loadOrders();
    }
  }

  setPage(p: number): void {
    this.page.set(p);
    this.loadOrders();
  }

  onFilterChange(): void {
    this.page.set(1);
    this.loadOrders();
  }

  clearAlerts(): void {
    this.errorMsg.set(null);
    this.successMsg.set(null);
  }
}
