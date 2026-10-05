import { z } from 'zod';
import { ValidationProblem } from './problem.js';

// Cursor pagination: list endpoints take ?cursor=&limit= and return { data, nextCursor }.

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Query schema for every list endpoint. `page`/`offset` are rejected (strict). */
export const ListQuery = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});
export type ListQuery = z.infer<typeof ListQuery>;

/** Response schema for a list endpoint: `pageOf(User)` → { data: User[], nextCursor: string | null }. */
export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), nextCursor: z.string().nullable() });
}

const CursorPayload = z.object({ after: z.number().int().min(0) });

export function encodeCursor(after: number): string {
  return Buffer.from(JSON.stringify({ after }), 'utf8').toString('base64url');
}

/** The position to continue after; a garbage cursor is a 422 problem. */
export function decodeCursor(cursor: string): number {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationProblem('Query parameters failed validation', 'cursor: Invalid cursor');
  }
  const result = CursorPayload.safeParse(decoded);
  if (!result.success) throw new ValidationProblem('Query parameters failed validation', 'cursor: Invalid cursor');
  return result.data.after;
}
