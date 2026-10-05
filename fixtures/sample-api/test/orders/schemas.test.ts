import { describe, expect, it } from 'vitest';
import { CreateOrderBody, Order, OrderIdParams, UpdateOrderBody } from '../../src/orders/schemas.js';

const valid = { customerEmail: 'a@example.com', amountCents: 1250, currency: 'EUR' };

describe('CreateOrderBody', () => {
  it('accepts a valid body', () => {
    expect(CreateOrderBody.parse(valid)).toEqual(valid);
  });

  it.each([
    [{ ...valid, customerEmail: 'nope' }],
    [{ ...valid, amountCents: 0 }],
    [{ ...valid, amountCents: 1.5 }],
    [{ ...valid, currency: 'JPY' }],
    [{ ...valid, status: 'paid' }],
    [{ amountCents: 1, currency: 'USD' }],
  ])('rejects %j', (body) => {
    expect(CreateOrderBody.safeParse(body).success).toBe(false);
  });
});

describe('UpdateOrderBody', () => {
  it('accepts a partial update', () => {
    expect(UpdateOrderBody.parse({ status: 'paid' })).toEqual({ status: 'paid' });
  });

  it('rejects an empty update and unknown fields', () => {
    expect(UpdateOrderBody.safeParse({}).success).toBe(false);
    expect(UpdateOrderBody.safeParse({ currency: 'USD' }).success).toBe(false);
  });
});

describe('Order and OrderIdParams', () => {
  it('validates ids and timestamps', () => {
    expect(OrderIdParams.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
    expect(
      Order.safeParse({
        ...valid,
        id: '5f0c6b9e-6d5a-4c1b-9a51-0f5c1c9d2e11',
        status: 'pending',
        createdAt: '2026-10-05T10:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
