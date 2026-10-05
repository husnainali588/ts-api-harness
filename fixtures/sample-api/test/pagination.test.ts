import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_LIMIT, ListQuery, MAX_LIMIT, decodeCursor, encodeCursor, pageOf } from '../src/pagination.js';
import { ValidationProblem } from '../src/problem.js';

describe('ListQuery', () => {
  it('defaults the limit', () => {
    expect(ListQuery.parse({})).toEqual({ limit: DEFAULT_LIMIT });
  });

  it('coerces a numeric limit from the query string', () => {
    expect(ListQuery.parse({ limit: '5' }).limit).toBe(5);
  });

  it.each(['0', String(MAX_LIMIT + 1), 'abc'])('rejects limit=%s', (limit) => {
    expect(ListQuery.safeParse({ limit }).success).toBe(false);
  });

  it('rejects page/offset style parameters', () => {
    expect(ListQuery.safeParse({ page: '2' }).success).toBe(false);
  });
});

describe('cursor codec', () => {
  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(42))).toBe(42);
  });

  it.each(['garbage!', encodeCursor(-1), Buffer.from('{"after":"x"}').toString('base64url')])(
    'rejects cursor %s with a 422 problem',
    (cursor) => {
      expect(() => decodeCursor(cursor)).toThrow(ValidationProblem);
    },
  );
});

describe('pageOf', () => {
  it('builds a { data, nextCursor } schema', () => {
    const Page = pageOf(z.string());
    expect(Page.parse({ data: ['a'], nextCursor: null })).toEqual({ data: ['a'], nextCursor: null });
    expect(Page.safeParse({ data: ['a'] }).success).toBe(false);
  });
});
