import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_LIMIT, ListQuery, MAX_LIMIT, decodeCursor, encodeCursor, pageOf } from '../../src/http/pagination.js';
import { ValidationProblem } from '../../src/http/problem.js';

describe('ListQuery', () => {
  it('defaults and coerces the limit', () => {
    expect(ListQuery.parse({})).toEqual({ limit: DEFAULT_LIMIT });
    expect(ListQuery.parse({ limit: '5', cursor: 'abc' })).toEqual({ limit: 5, cursor: 'abc' });
  });

  it.each(['0', String(MAX_LIMIT + 1), 'x'])('rejects limit=%s', (limit) => {
    expect(ListQuery.safeParse({ limit }).success).toBe(false);
  });

  it('rejects page/offset parameters', () => {
    expect(ListQuery.safeParse({ offset: '10' }).success).toBe(false);
  });
});

describe('cursor codec', () => {
  it('round-trips and rejects garbage with a 422 problem', () => {
    expect(decodeCursor(encodeCursor(5))).toBe(5);
    expect(() => decodeCursor('garbage!')).toThrow(ValidationProblem);
    expect(() => decodeCursor(Buffer.from('{"after":-1}').toString('base64url'))).toThrow(ValidationProblem);
  });
});

describe('pageOf', () => {
  it('describes { data, nextCursor }', () => {
    expect(pageOf(z.number()).parse({ data: [1], nextCursor: null })).toEqual({ data: [1], nextCursor: null });
  });
});
