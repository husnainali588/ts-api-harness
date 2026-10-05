import { randomUUID } from 'node:crypto';
import type { CreateOrderBody, Order, UpdateOrderBody } from './schemas.js';

// In-memory store. Each order gets a monotonic sequence number so cursors survive deletes.

interface Row {
  seq: number;
  order: Order;
}

export interface ListResult {
  orders: Order[];
  lastSeq: number | null;
  hasMore: boolean;
}

export class OrderStore {
  private readonly rows = new Map<string, Row>();
  private nextSeq = 1;

  create(input: CreateOrderBody): Order {
    const order: Order = {
      id: randomUUID(),
      customerEmail: input.customerEmail,
      amountCents: input.amountCents,
      currency: input.currency,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.rows.set(order.id, { seq: this.nextSeq, order });
    this.nextSeq += 1;
    return order;
  }

  get(id: string): Order | undefined {
    return this.rows.get(id)?.order;
  }

  update(id: string, patch: UpdateOrderBody): Order | undefined {
    const row = this.rows.get(id);
    if (row === undefined) return undefined;
    row.order = { ...row.order, ...patch };
    return row.order;
  }

  delete(id: string): boolean {
    return this.rows.delete(id);
  }

  list(afterSeq: number, limit: number): ListResult {
    const rows = [...this.rows.values()].filter((row) => row.seq > afterSeq).sort((a, b) => a.seq - b.seq);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { orders: page.map((row) => row.order), lastSeq: last === undefined ? null : last.seq, hasMore: rows.length > limit };
  }
}
