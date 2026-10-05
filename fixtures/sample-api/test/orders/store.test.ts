import { describe, expect, it } from 'vitest';
import { OrderStore } from '../../src/orders/store.js';

const input = { customerEmail: 'a@example.com', amountCents: 500, currency: 'USD' as const };

describe('OrderStore', () => {
  it('creates pending orders with ids and timestamps', () => {
    const order = new OrderStore().create(input);
    expect(order).toMatchObject({ ...input, status: 'pending' });
    expect(order.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gets, updates and deletes', () => {
    const store = new OrderStore();
    const { id } = store.create(input);
    expect(store.get(id)?.amountCents).toBe(500);
    expect(store.update(id, { status: 'paid' })?.status).toBe('paid');
    expect(store.delete(id)).toBe(true);
    expect(store.get(id)).toBeUndefined();
    expect(store.update(id, { status: 'paid' })).toBeUndefined();
    expect(store.delete(id)).toBe(false);
  });

  it('lists in creation order with a stable position across deletes', () => {
    const store = new OrderStore();
    const ids = [1, 2, 3, 4].map((n) => store.create({ ...input, amountCents: n }).id);
    const first = store.list(0, 2);
    expect(first.orders.map((o) => o.amountCents)).toEqual([1, 2]);
    expect(first.hasMore).toBe(true);
    const [, secondId] = ids;
    if (secondId !== undefined) store.delete(secondId);
    const next = store.list(first.lastSeq ?? 0, 2);
    expect(next.orders.map((o) => o.amountCents)).toEqual([3, 4]);
    expect(next.hasMore).toBe(false);
  });

  it('returns an empty page past the end', () => {
    expect(new OrderStore().list(0, 10)).toEqual({ orders: [], lastSeq: null, hasMore: false });
  });
});
