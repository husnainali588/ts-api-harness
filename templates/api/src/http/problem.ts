import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

// RFC 7807 problem details. Every non-2xx response is built here; route code throws the errors below.

export const PROBLEM_TYPE_BASE = 'https://api.sf/problems/';

export const Problem = z.object({
  type: z.url(),
  title: z.string().min(1),
  status: z.number().int().min(400).max(599),
  detail: z.string(),
  instance: z.string().startsWith('/'),
});
export type Problem = z.infer<typeof Problem>;

export class HttpProblem extends Error {
  constructor(
    readonly status: number,
    readonly slug: string,
    readonly title: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'HttpProblem';
  }
}

/** 404: the addressed resource does not exist. */
export class NotFound extends HttpProblem {
  constructor(detail: string) {
    super(404, 'not-found', 'Resource not found', detail);
  }
}

/** 409: the request conflicts with current state (e.g. a duplicate unique field). */
export class Conflict extends HttpProblem {
  constructor(detail: string) {
    super(409, 'conflict', 'Conflict', detail);
  }
}

/** 422: the request is well-formed JSON but fails validation. */
export class ValidationProblem extends HttpProblem {
  constructor(title: string, detail: string) {
    super(422, 'validation', title, detail);
  }
}

export type InputSource = 'body' | 'query' | 'params' | 'headers';

const TITLES: Record<InputSource, string> = {
  body: 'Request body failed validation',
  query: 'Query parameters failed validation',
  params: 'Path parameters failed validation',
  headers: 'Request headers failed validation',
};

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/** Parses untrusted input; a failure becomes a 422 problem. */
export function parseInput<T extends z.ZodType>(schema: T, value: unknown, source: InputSource): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationProblem(TITLES[source], formatIssues(result.error));
  return result.data;
}

export function requestPath(req: Request): string {
  return new URL(req.originalUrl, 'http://localhost').pathname;
}

export function problem(req: Request, status: number, slug: string, title: string, detail: string): Problem {
  return Problem.parse({ type: `${PROBLEM_TYPE_BASE}${slug}`, title, status, detail, instance: requestPath(req) });
}

export function sendProblem(res: Response, body: Problem): void {
  // Set the media type first: res.json() only defaults to application/json when no Content-Type is set.
  res.status(body.status).type('application/problem+json').json(body);
}

/** Catch-all 404 for unknown routes and unsupported methods. */
export function notFoundHandler(req: Request, res: Response): void {
  sendProblem(res, problem(req, 404, 'not-found', 'Route not found', `No route for ${req.method} ${requestPath(req)}`));
}

function errorType(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'type' in err && typeof err.type === 'string' ? err.type : undefined;
}

function clientStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number') {
    return err.status >= 400 && err.status < 500 ? err.status : undefined;
  }
  return undefined;
}

/** Fallback error handler: problems keep their status, malformed JSON is 400, anything unknown is 500 without a stack. */
export function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof HttpProblem) {
    sendProblem(res, problem(req, err.status, err.slug, err.title, err.detail));
    return;
  }
  if (errorType(err) === 'entity.parse.failed') {
    sendProblem(res, problem(req, 400, 'malformed-json', 'Malformed JSON body', 'The request body is not valid JSON.'));
    return;
  }
  const status = clientStatus(err);
  if (status !== undefined) {
    sendProblem(res, problem(req, status, 'bad-request', 'Bad request', 'The request could not be processed.'));
    return;
  }
  sendProblem(res, problem(req, 500, 'internal', 'Internal server error', 'An unexpected error occurred.'));
}
