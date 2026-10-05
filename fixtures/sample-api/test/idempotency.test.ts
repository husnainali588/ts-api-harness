import { describe, expect, it } from 'vitest';
import { IdempotencyKey, IdempotencyStore, fingerprint } from '../src/idempotency.js';
import { Conflict } from '../src/problem.js';

const stored = { status: 201, location: '/v1/orders/1', body: { id: '1' } };

describe('IdempotencyStore', () => {
  it('misses for a new key', () => {
    expect(new IdempotencyStore().lookup('POST /v1/orders', 'k1', { a: 1 })).toBeUndefined();
  });

  it('replays the stored response for the same key and body', () => {
    const store = new IdempotencyStore();
    store.save('POST /v1/orders', 'k1', { a: 1 }, stored);
    expect(store.lookup('POST /v1/orders', 'k1', { a: 1 })).toEqual(stored);
  });

  it('raises a conflict for the same key with a different body', () => {
    const store = new IdempotencyStore();
    store.save('POST /v1/orders', 'k1', { a: 1 }, stored);
    expect(() => store.lookup('POST /v1/orders', 'k1', { a: 2 })).toThrow(Conflict);
  });

  it('scopes keys per endpoint', () => {
    const store = new IdempotencyStore();
    store.save('POST /v1/orders', 'k1', { a: 1 }, stored);
    expect(store.lookup('POST /v1/refunds', 'k1', { a: 2 })).toBeUndefined();
  });
});

describe('IdempotencyKey', () => {
  it('is optional and bounded', () => {
    expect(IdempotencyKey.safeParse(undefined).success).toBe(true);
    expect(IdempotencyKey.safeParse('').success).toBe(false);
    expect(IdempotencyKey.safeParse('x'.repeat(256)).success).toBe(false);
  });
});

describe('fingerprint', () => {
  it('is stable for equal bodies', () => {
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});
