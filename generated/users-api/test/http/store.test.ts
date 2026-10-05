import { describe, expect, it } from 'vitest';
import { ValidationProblem } from '../../src/http/problem.js';
import { MemoryStore } from '../../src/http/store.js';

interface Row {
  id: string;
  n: number;
}

describe('MemoryStore', () => {
  it('inserts, gets, replaces, finds and deletes', () => {
    const store = new MemoryStore<Row>();
    store.insert({ id: 'a', n: 1 });
    expect(store.get('a')).toEqual({ id: 'a', n: 1 });
    expect(store.replace('a', { id: 'a', n: 2 })).toEqual({ id: 'a', n: 2 });
    expect(store.find((r) => r.n === 2)?.id).toBe('a');
    expect(store.delete('a')).toBe(true);
    expect(store.get('a')).toBeUndefined();
    expect(store.replace('a', { id: 'a', n: 3 })).toBeUndefined();
    expect(store.find(() => true)).toBeUndefined();
  });

  it('pages in insertion order with cursors that survive deletes', () => {
    const store = new MemoryStore<Row>();
    for (const n of [1, 2, 3, 4]) store.insert({ id: `r${n}`, n });
    const first = store.page(undefined, 2);
    expect(first.data.map((r) => r.n)).toEqual([1, 2]);
    store.delete('r3');
    const second = store.page(first.nextCursor ?? undefined, 2);
    expect(second).toEqual({ data: [{ id: 'r4', n: 4 }], nextCursor: null });
  });

  it('rejects a garbage cursor', () => {
    expect(() => new MemoryStore<Row>().page('nope!', 5)).toThrow(ValidationProblem);
  });
});
