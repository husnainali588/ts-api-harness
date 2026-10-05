import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Conflict } from './problem.js';

// Optional Idempotency-Key on unsafe requests: same key + same body replays the first response,
// same key + different body is a 409.

export const IdempotencyKey = z.string().min(1).max(255).optional();

export interface StoredResponse {
  status: number;
  location: string;
  body: unknown;
}

interface Entry {
  fingerprint: string;
  response: StoredResponse;
}

export function fingerprint(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  /** The stored response for a replay, undefined for a new key, Conflict for a reused key with a different body. */
  lookup(scope: string, key: string, body: unknown): StoredResponse | undefined {
    const entry = this.entries.get(`${scope} ${key}`);
    if (entry === undefined) return undefined;
    if (entry.fingerprint !== fingerprint(body)) {
      throw new Conflict('Idempotency-Key was already used with a different request body.');
    }
    return entry.response;
  }

  save(scope: string, key: string, body: unknown, response: StoredResponse): void {
    this.entries.set(`${scope} ${key}`, { fingerprint: fingerprint(body), response });
  }
}
