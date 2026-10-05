import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Problem, errorHandler, notFoundHandler } from '../../src/http/problem.js';
import { NoContent, defineRoute, mountRoute, type AnyRoute } from '../../src/http/route.js';

const Item = z.object({ id: z.string(), n: z.number() });

function appWith(...routes: AnyRoute[]) {
  const app = express();
  app.use(express.json());
  for (const route of routes) mountRoute(app, route);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const getItem = defineRoute({
  method: 'get',
  path: '/v1/items/:id',
  params: z.object({ id: z.string().regex(/^\d+$/) }),
  responses: { 200: Item },
  handler: ({ params }) => ({ status: 200, body: { id: params.id, n: Number(params.id) } }),
});

const listItems = defineRoute({
  method: 'get',
  path: '/v1/items',
  query: z.strictObject({ limit: z.coerce.number().int().min(1).max(5) }),
  responses: { 200: z.object({ data: z.array(Item), nextCursor: z.string().nullable() }) },
  handler: ({ query }) => ({ status: 200, body: { data: [{ id: '1', n: query.limit }], nextCursor: null } }),
});

const putItem = defineRoute({
  method: 'put',
  path: '/v1/items/:id',
  params: z.object({ id: z.string() }),
  body: z.strictObject({ n: z.number() }),
  responses: { 200: Item },
  handler: ({ params, body }) => ({ status: 200, body: { id: params.id, n: body.n } }),
});

const patchItem = defineRoute({
  method: 'patch',
  path: '/v1/items/:id',
  params: z.object({ id: z.string() }),
  body: z.strictObject({ n: z.number() }),
  responses: { 200: Item },
  // Breaks its own contract on purpose: n must be a number.
  handler: ({ params }) => ({ status: 200, body: { id: params.id, n: Number.NaN } }),
});

const deleteItem = defineRoute({
  method: 'delete',
  path: '/v1/items/:id',
  params: z.object({ id: z.string() }),
  responses: { 204: NoContent },
  handler: () => ({ status: 204 }),
});

const createItem = defineRoute({
  method: 'post',
  path: '/v1/items',
  body: z.strictObject({ n: z.number() }),
  responses: { 201: Item },
  handler: ({ body }) => ({ status: 201, body: { id: '9', n: body.n }, location: '/v1/items/9' }),
});

describe('defineRoute + mountRoute', () => {
  const app = appWith(getItem, listItems, putItem, patchItem, deleteItem, createItem);

  it('parses params and validates the reply', async () => {
    const res = await request(app).get('/v1/items/7');
    expect(res.status).toBe(200);
    expect(Item.parse(res.body)).toEqual({ id: '7', n: 7 });
  });

  it('422s invalid params, query and body', async () => {
    expect(Problem.parse((await request(app).get('/v1/items/abc')).body)).toMatchObject({ status: 422, title: 'Path parameters failed validation' });
    expect(Problem.parse((await request(app).get('/v1/items?limit=50')).body)).toMatchObject({ status: 422, title: 'Query parameters failed validation' });
    expect(Problem.parse((await request(app).put('/v1/items/1').send({ n: 'x' })).body)).toMatchObject({ status: 422, title: 'Request body failed validation' });
  });

  it('parses query values', async () => {
    const res = await request(app).get('/v1/items?limit=3');
    expect(res.status).toBe(200);
  });

  it('turns a reply that breaks its schema into a 500 problem', async () => {
    const res = await request(app).patch('/v1/items/1').send({ n: 1 });
    expect(res.status).toBe(500);
    expect(Problem.parse(res.body).status).toBe(500);
  });

  it('sends 201 with Location and 204 without a body', async () => {
    const created = await request(app).post('/v1/items').send({ n: 1 });
    expect(created.status).toBe(201);
    expect(created.get('Location')).toBe('/v1/items/9');
    const deleted = await request(app).delete('/v1/items/9');
    expect(deleted.status).toBe(204);
    expect(deleted.text).toBe('');
  });

  it('500s a status without a response schema', async () => {
    const bad = defineRoute({
      method: 'get',
      path: '/v1/odd',
      responses: { 200: Item },
      handler: () => ({ status: 200, body: { id: '1', n: 1 } }),
    });
    const odd: AnyRoute = { ...bad, handler: () => ({ status: 299, body: {} }) };
    const res = await request(appWith(odd)).get('/v1/odd');
    expect(res.status).toBe(500);
  });
});
