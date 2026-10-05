import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app.js';
import { Problem } from '../src/http/problem.js';
import { defineRoute } from '../src/http/route.js';

const ping = defineRoute({
  method: 'post',
  path: '/v1/pings',
  body: z.strictObject({ n: z.number() }),
  responses: { 201: z.object({ n: z.number() }) },
  handler: ({ body }) => ({ status: 201, body: { n: body.n }, location: `/v1/pings/${body.n}` }),
});

describe('createApp', () => {
  it('exposes the route table', () => {
    expect(createApp([ping]).routeTable.map((r) => `${r.method} ${r.path}`)).toEqual(['post /v1/pings']);
  });

  it('answers unknown routes with a 404 problem', async () => {
    const res = await request(createApp([])).get('/v1/nothing');
    expect(res.status).toBe(404);
    expect(res.get('Content-Type')).toMatch(/^application\/problem\+json/);
    expect(Problem.parse(res.body)).toMatchObject({ status: 404, instance: '/v1/nothing' });
  });

  it('turns malformed JSON into a 400 problem', async () => {
    const res = await request(createApp([ping])).post('/v1/pings').set('Content-Type', 'application/json').send('{"n":');
    expect(res.status).toBe(400);
    expect(Problem.parse(res.body).type).toBe('https://api.sf/problems/malformed-json');
  });

  it('honours Idempotency-Key on POST', async () => {
    const app = createApp([ping]);
    const first = await request(app).post('/v1/pings').set('Idempotency-Key', 'k').send({ n: 1 });
    const replay = await request(app).post('/v1/pings').set('Idempotency-Key', 'k').send({ n: 1 });
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    expect(replay.get('Location')).toBe('/v1/pings/1');
    const reuse = await request(app).post('/v1/pings').set('Idempotency-Key', 'k').send({ n: 2 });
    expect(reuse.status).toBe(409);
    expect(Problem.parse(reuse.body).status).toBe(409);
  });

  it('does not advertise the framework', async () => {
    const res = await request(createApp([])).get('/v1/nothing');
    expect(res.get('X-Powered-By')).toBeUndefined();
  });
});
