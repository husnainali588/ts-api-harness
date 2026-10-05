import type { Express, Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { parseInput } from './problem.js';

// defineRoute: the only way routes are declared. Every input is parsed with its schema before the handler runs,
// and every reply is validated against responses[status] before it is sent.

export type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type ResponseMap = { [status: number]: z.ZodType };

/** No-content response schema, e.g. `responses: { 204: NoContent }`. */
export const NoContent = z.undefined();

/**
 * What a handler returns: a status that has a schema in `responses`, its body, and an optional Location.
 * The body is validated against responses[status] before sending; a mismatch is a 500.
 */
export interface Reply {
  status: number;
  body?: unknown;
  location?: string;
}

export interface RouteInput<P, Q, B> {
  params: P;
  query: Q;
  body: B;
}

export interface RouteDef<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  B extends z.ZodType = z.ZodType,
  R extends ResponseMap = ResponseMap,
> {
  method: Method;
  /** Full path, e.g. '/v1/users/:id'. */
  path: string;
  params?: P;
  query?: Q;
  body?: B;
  responses: R;
  handler(input: RouteInput<z.output<P>, z.output<Q>, z.output<B>>): Reply | Promise<Reply>;
}

/** Any route made with defineRoute (what the route table holds). */
export interface AnyRoute {
  method: Method;
  path: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
  responses: ResponseMap;
  handler(input: RouteInput<unknown, unknown, unknown>): Reply | Promise<Reply>;
}

export function defineRoute<
  P extends z.ZodType = z.ZodUndefined,
  Q extends z.ZodType = z.ZodUndefined,
  B extends z.ZodType = z.ZodUndefined,
  R extends ResponseMap = ResponseMap,
>(def: RouteDef<P, Q, B, R>): RouteDef<P, Q, B, R> {
  return def;
}

/** A reply that does not match its response schema is a server bug: 500, details stay in the server. */
export class ResponseContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResponseContractError';
  }
}

function handlerFor(route: AnyRoute): RequestHandler {
  return async (req: Request, res: Response) => {
    const params = route.params === undefined ? undefined : parseInput(route.params, req.params, 'params');
    const query = route.query === undefined ? undefined : parseInput(route.query, req.query, 'query');
    const body = route.body === undefined ? undefined : parseInput(route.body, req.body, 'body');
    const reply = await route.handler({ params, query, body });
    const schema = route.responses[reply.status];
    if (schema === undefined) throw new ResponseContractError(`${route.method} ${route.path}: no response schema for ${reply.status}`);
    const checked = schema.safeParse(reply.body);
    if (!checked.success) throw new ResponseContractError(`${route.method} ${route.path}: reply does not match responses[${reply.status}]`);
    if (reply.location !== undefined) res.location(reply.location);
    if (checked.data === undefined) {
      res.status(reply.status).end();
      return;
    }
    res.status(reply.status).json(checked.data);
  };
}

export function mountRoute(app: Express, route: AnyRoute): void {
  const handler = handlerFor(route);
  switch (route.method) {
    case 'get':
      app.get(route.path, handler);
      break;
    case 'post':
      app.post(route.path, handler);
      break;
    case 'put':
      app.put(route.path, handler);
      break;
    case 'patch':
      app.patch(route.path, handler);
      break;
    case 'delete':
      app.delete(route.path, handler);
      break;
  }
}
