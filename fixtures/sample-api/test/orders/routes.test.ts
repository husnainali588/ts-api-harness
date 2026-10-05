import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { ordersRouter } from '../../src/orders/routes.js';
import { Order, OrderPage } from '../../src/orders/schemas.js';
import { Problem, errorHandler, notFoundHandler } from '../../src/problem.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/orders', ordersRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const body = { customerEmail: 'a@example.com', amountCents: 1250, currency: 'EUR' };
const missingId = '5f0c6b9e-6d5a-4c1b-9a51-0f5c1c9d2e11';

let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  app = buildApp();
});

async function create(payload: object = body) {
  const res = await request(app).post('/v1/orders').send(payload);
  return Order.parse(res.body);
}

function expectProblem(res: request.Response, status: number, instance: string) {
  expect(res.status).toBe(status);
  expect(res.get('Content-Type')).toMatch(/^application\/problem\+json/);
  const problem = Problem.parse(res.body);
  expect(problem.status).toBe(status);
  expect(problem.instance).toBe(instance);
  return problem;
}

describe('POST /v1/orders', () => {
  it('creates an order: 201 with Location', async () => {
    const res = await request(app).post('/v1/orders').send(body);
    expect(res.status).toBe(201);
    const order = Order.parse(res.body);
    expect(order).toMatchObject({ ...body, status: 'pending' });
    expect(res.get('Location')).toBe(`/v1/orders/${order.id}`);
  });

  it('rejects an invalid body with a 422 problem', async () => {
    const res = await request(app).post('/v1/orders').send({ ...body, customerEmail: 'nope' });
    const problem = expectProblem(res, 422, '/v1/orders');
    expect(problem.detail).toMatch(/customerEmail/);
  });

  it('rejects a missing body with a 422 problem', async () => {
    expectProblem(await request(app).post('/v1/orders'), 422, '/v1/orders');
  });

  it('replays the same Idempotency-Key and body', async () => {
    const first = await request(app).post('/v1/orders').set('Idempotency-Key', 'abc').send(body);
    const second = await request(app).post('/v1/orders').set('Idempotency-Key', 'abc').send(body);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
    expect(second.get('Location')).toBe(first.get('Location'));
    const list = OrderPage.parse((await request(app).get('/v1/orders')).body);
    expect(list.data).toHaveLength(1);
  });

  it('rejects an Idempotency-Key reused with a different body: 409 problem', async () => {
    await request(app).post('/v1/orders').set('Idempotency-Key', 'abc').send(body);
    const res = await request(app).post('/v1/orders').set('Idempotency-Key', 'abc').send({ ...body, amountCents: 1 });
    expectProblem(res, 409, '/v1/orders');
  });
});

describe('GET /v1/orders', () => {
  it('pages with cursor and limit', async () => {
    for (const amountCents of [1, 2, 3]) await create({ ...body, amountCents });
    const first = OrderPage.parse((await request(app).get('/v1/orders?limit=2')).body);
    expect(first.data.map((o) => o.amountCents)).toEqual([1, 2]);
    expect(first.nextCursor).not.toBeNull();
    const second = OrderPage.parse(
      (await request(app).get('/v1/orders').query({ limit: 2, cursor: first.nextCursor ?? '' })).body,
    );
    expect(second.data.map((o) => o.amountCents)).toEqual([3]);
    expect(second.nextCursor).toBeNull();
  });

  it.each(['limit=0', 'limit=10000', 'cursor=garbage!', 'page=2'])('rejects %s with a 422 problem', async (qs) => {
    expectProblem(await request(app).get(`/v1/orders?${qs}`), 422, '/v1/orders');
  });
});

describe('GET /v1/orders/:id', () => {
  it('returns an order', async () => {
    const order = await create();
    const res = await request(app).get(`/v1/orders/${order.id}`);
    expect(res.status).toBe(200);
    expect(Order.parse(res.body)).toEqual(order);
  });

  it('404s an unknown id', async () => {
    expectProblem(await request(app).get(`/v1/orders/${missingId}`), 404, `/v1/orders/${missingId}`);
  });

  it('422s a malformed id', async () => {
    expectProblem(await request(app).get('/v1/orders/not-a-uuid'), 422, '/v1/orders/not-a-uuid');
  });
});

describe('PATCH /v1/orders/:id', () => {
  it('partially updates an order', async () => {
    const order = await create();
    const res = await request(app).patch(`/v1/orders/${order.id}`).send({ status: 'paid' });
    expect(res.status).toBe(200);
    expect(Order.parse(res.body)).toEqual({ ...order, status: 'paid' });
  });

  it('422s an empty or unknown-field body', async () => {
    const order = await create();
    expectProblem(await request(app).patch(`/v1/orders/${order.id}`).send({}), 422, `/v1/orders/${order.id}`);
    expectProblem(
      await request(app).patch(`/v1/orders/${order.id}`).send({ currency: 'USD' }),
      422,
      `/v1/orders/${order.id}`,
    );
  });

  it('404s an unknown id', async () => {
    expectProblem(
      await request(app).patch(`/v1/orders/${missingId}`).send({ status: 'paid' }),
      404,
      `/v1/orders/${missingId}`,
    );
  });
});

describe('DELETE /v1/orders/:id', () => {
  it('deletes: 204 with no body, then 404', async () => {
    const order = await create();
    const res = await request(app).delete(`/v1/orders/${order.id}`);
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
    expectProblem(await request(app).get(`/v1/orders/${order.id}`), 404, `/v1/orders/${order.id}`);
  });

  it('404s an unknown id', async () => {
    expectProblem(await request(app).delete(`/v1/orders/${missingId}`), 404, `/v1/orders/${missingId}`);
  });
});
