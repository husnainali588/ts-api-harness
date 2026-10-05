import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { fingerprint, idempotency } from '../../src/http/idempotency.js';
import { Problem, errorHandler } from '../../src/http/problem.js';

function counterApp() {
  let count = 0;
  const app = express();
  app.use(express.json());
  app.use(idempotency());
  app.post('/v1/counters', (_req, res) => {
    count += 1;
    res.status(201).location(`/v1/counters/${count}`).json({ count });
  });
  app.get('/v1/counters', (_req, res) => {
    res.status(200).json({ count });
  });
  app.use(errorHandler);
  return app;
}

describe('idempotency middleware', () => {
  it('replays the first response for the same key and body', async () => {
    const app = counterApp();
    const a = await request(app).post('/v1/counters').set('Idempotency-Key', 'k1').send({ x: 1 });
    const b = await request(app).post('/v1/counters').set('Idempotency-Key', 'k1').send({ x: 1 });
    expect(b.status).toBe(201);
    expect(b.body).toEqual(a.body);
    expect(b.get('Location')).toBe('/v1/counters/1');
  });

  it('409s a reused key with a different body', async () => {
    const app = counterApp();
    await request(app).post('/v1/counters').set('Idempotency-Key', 'k1').send({ x: 1 });
    const res = await request(app).post('/v1/counters').set('Idempotency-Key', 'k1').send({ x: 2 });
    expect(res.status).toBe(409);
    expect(Problem.parse(res.body).status).toBe(409);
  });

  it('ignores requests without the header and non-POST methods', async () => {
    const app = counterApp();
    await request(app).post('/v1/counters').send({});
    const res = await request(app).post('/v1/counters').send({});
    expect(res.body).toEqual({ count: 2 });
    expect((await request(app).get('/v1/counters').set('Idempotency-Key', 'k')).status).toBe(200);
  });

  it('422s an oversized key', async () => {
    const res = await request(counterApp()).post('/v1/counters').set('Idempotency-Key', 'k'.repeat(256)).send({});
    expect(res.status).toBe(422);
  });

  it('fingerprints bodies stably', () => {
    expect(fingerprint({ a: 1 })).toBe(fingerprint({ a: 1 }));
    expect(fingerprint(undefined)).toBe(fingerprint(undefined));
  });
});
