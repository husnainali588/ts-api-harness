import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Conflict, NotFound, Problem, ValidationProblem, errorHandler, notFoundHandler, parseInput } from '../../src/http/problem.js';

function appThrowing(error: unknown) {
  const app = express();
  app.get('/v1/things/:id', () => {
    throw error;
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('parseInput', () => {
  it('returns parsed data or throws a 422 naming the field', () => {
    expect(parseInput(z.object({ n: z.number() }), { n: 1 }, 'body')).toEqual({ n: 1 });
    expect(() => parseInput(z.object({ email: z.email() }), { email: 'x' }, 'query')).toThrow(ValidationProblem);
    try {
      parseInput(z.object({ email: z.email() }), { email: 'x' }, 'query');
    } catch (error) {
      expect(error instanceof ValidationProblem && error.title).toBe('Query parameters failed validation');
      expect(error instanceof ValidationProblem && error.detail).toMatch(/^email: /);
    }
  });
});

describe('errorHandler', () => {
  it.each([
    [new NotFound('gone'), 404, 'not-found'],
    [new Conflict('taken'), 409, 'conflict'],
    [new ValidationProblem('Request body failed validation', 'x: bad'), 422, 'validation'],
  ])('maps %s to a %i problem', async (error, status, slug) => {
    const res = await request(appThrowing(error)).get('/v1/things/1?q=1');
    expect(res.status).toBe(status);
    expect(res.get('Content-Type')).toMatch(/^application\/problem\+json/);
    expect(Problem.parse(res.body)).toMatchObject({ status, type: `https://api.sf/problems/${slug}`, instance: '/v1/things/1' });
  });

  it('hides unknown errors behind a 500 without a stack', async () => {
    const res = await request(appThrowing(new Error('secret internals'))).get('/v1/things/1');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('secret internals');
    expect(Problem.parse(res.body).status).toBe(500);
  });

  it('keeps other client errors as problems', async () => {
    const res = await request(appThrowing(Object.assign(new Error('big'), { status: 413 }))).get('/v1/things/1');
    expect(Problem.parse(res.body).status).toBe(413);
  });

  it('answers unknown routes through notFoundHandler', async () => {
    const res = await request(appThrowing(new Error('x'))).get('/v1/other');
    expect(Problem.parse(res.body)).toMatchObject({ status: 404, instance: '/v1/other' });
  });
});
