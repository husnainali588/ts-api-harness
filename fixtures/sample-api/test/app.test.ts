import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Problem } from '../src/problem.js';

describe('createApp', () => {
  it('answers unknown routes with a 404 problem', async () => {
    const res = await request(createApp()).get('/v1/unknown');
    expect(res.status).toBe(404);
    expect(res.get('Content-Type')).toMatch(/^application\/problem\+json/);
    const body = Problem.parse(res.body);
    expect(body.status).toBe(404);
    expect(body.instance).toBe('/v1/unknown');
  });

  it('answers an unsupported method with a 404 problem', async () => {
    const res = await request(createApp()).put('/v1/orders');
    expect(res.status).toBe(404);
    expect(Problem.parse(res.body).instance).toBe('/v1/orders');
  });

  it('turns malformed JSON into a 400 problem', async () => {
    const res = await request(createApp()).post('/v1/orders').set('Content-Type', 'application/json').send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.get('Content-Type')).toMatch(/^application\/problem\+json/);
    expect(Problem.parse(res.body).type).toBe('https://api.sf/problems/malformed-json');
  });

  it('does not advertise the framework', async () => {
    const res = await request(createApp()).get('/v1/orders');
    expect(res.get('X-Powered-By')).toBeUndefined();
  });
});
