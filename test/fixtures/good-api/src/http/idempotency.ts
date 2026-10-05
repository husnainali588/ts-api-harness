import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Conflict, ValidationProblem } from './problem.js';

// Optional Idempotency-Key on POST: same key + same body replays the first success (status, Location, body);
// same key + different body is a 409. Requests without the header are unaffected.

interface Stored {
  fingerprint: string;
  status: number;
  location: string | undefined;
  body: unknown;
}

export function fingerprint(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body) ?? '').digest('hex');
}

export function idempotency() {
  const stored = new Map<string, Stored>();
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.get('Idempotency-Key');
    if (req.method !== 'POST' || key === undefined) {
      next();
      return;
    }
    if (key.length < 1 || key.length > 255) {
      next(new ValidationProblem('Request headers failed validation', 'Idempotency-Key: must be 1-255 characters'));
      return;
    }
    const scope = `${req.method} ${req.path} ${key}`;
    const payload: unknown = req.body;
    const print = fingerprint(payload);
    const hit = stored.get(scope);
    if (hit !== undefined) {
      if (hit.fingerprint !== print) {
        next(new Conflict('Idempotency-Key was already used with a different request body.'));
        return;
      }
      if (hit.location !== undefined) res.location(hit.location);
      res.status(hit.status).json(hit.body);
      return;
    }
    const send = res.json.bind(res);
    res.json = (body?: unknown) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        stored.set(scope, { fingerprint: print, status: res.statusCode, location: res.get('Location'), body });
      }
      return send(body);
    };
    next();
  };
}
