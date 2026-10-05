import { decodeCursor, encodeCursor } from './pagination.js';

// In-memory store for one resource. Rows keep an insertion sequence so cursors survive deletes.

export class MemoryStore<T extends { id: string }> {
  private readonly rows = new Map<string, { seq: number; item: T }>();
  private seq = 0;

  insert(item: T): T {
    this.seq += 1;
    this.rows.set(item.id, { seq: this.seq, item });
    return item;
  }

  get(id: string): T | undefined {
    return this.rows.get(id)?.item;
  }

  /** Replaces an existing row; undefined if it does not exist. */
  replace(id: string, item: T): T | undefined {
    const row = this.rows.get(id);
    if (row === undefined) return undefined;
    row.item = item;
    return item;
  }

  delete(id: string): boolean {
    return this.rows.delete(id);
  }

  find(predicate: (item: T) => boolean): T | undefined {
    for (const { item } of this.rows.values()) if (predicate(item)) return item;
    return undefined;
  }

  /** One page in insertion order; an invalid cursor throws a 422 problem. */
  page(cursor: string | undefined, limit: number): { data: T[]; nextCursor: string | null } {
    const after = cursor === undefined ? 0 : decodeCursor(cursor);
    const rows = [...this.rows.values()].filter((row) => row.seq > after).sort((a, b) => a.seq - b.seq);
    const slice = rows.slice(0, limit);
    const last = slice.at(-1);
    const nextCursor = rows.length > limit && last !== undefined ? encodeCursor(last.seq) : null;
    return { data: slice.map((row) => row.item), nextCursor };
  }
}
