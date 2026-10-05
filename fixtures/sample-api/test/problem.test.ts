import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Conflict, NotFound, Problem, ValidationProblem, errorHandler, parseInput } from '../src/problem.js';

function appThrowing(error: unknown) {
  const app = express();
  app.get('/v1/things/:id', () => {
    throw error;
  });
  app.use(errorHandler);
  return app;
}

describe('parseInput', () => {
  it('returns parsed data', () => {
    expect(parseInput(z.object({ n: z.number() }), { n: 1 }, 'body')).toEqual({ n: 1 });
  });

  it('throws a 422 ValidationProblem naming the field', () => {
    try {
      parseInput(z.object({ email: z.email() }), { email: 'nope' }, 'body');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationProblem);
      if (error instanceof ValidationProblem) {
        expect(error.status).toBe(422);
        expect(error.title).toBe('Request body failed validation');
        expect(error.detail).toMatch(/^email: /);
      }
    }
  });
});

describe('errorHandler', () => {
  it.each([
    [new NotFound('gone'), 404, 'not-found'],
    [new Conflict('taken'), 409, 'conflict'],
    [new ValidationProblem('Request body failed validation', 'x: bad'), 422, 'validation'],
  ])('maps %s to its status', async (error, status, slug) => {
    const res = await request(appThrowing(error)).get('/v1/things/1?x=1');
    expect(res.status).toBe(status);
    expect(res.get('Content-Type')).toMatch(/^application\/problem\+json/);
    const body = Problem.parse(res.body);
    expect(body).toMatchObject({ status, type: `https://api.sf/problems/${slug}`, instance: '/v1/things/1' });
  });

  it('hides unexpected errors behind a 500 without a stack trace', async () => {
    const res = await request(appThrowing(new Error('secret internals'))).get('/v1/things/1');
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('secret internals');
    expect(res.text).not.toContain('at ');
    expect(Problem.parse(res.body).status).toBe(500);
  });

  it('keeps other client errors as problems', async () => {
    const res = await request(appThrowing(Object.assign(new Error('too big'), { status: 413 }))).get('/v1/things/1');
    expect(res.status).toBe(413);
    expect(Problem.parse(res.body).status).toBe(413);
  });
});
