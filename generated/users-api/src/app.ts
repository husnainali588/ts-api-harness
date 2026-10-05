import express, { type Express } from 'express';
import { idempotency } from './http/idempotency.js';
import { errorHandler, notFoundHandler } from './http/problem.js';
import { mountRoute, type AnyRoute } from './http/route.js';
import { routes as allRoutes } from './routes/index.js';

export type App = Express & { readonly routeTable: readonly AnyRoute[] };

/** Builds the app. `routeTable` exposes every mounted route (method, path, schemas) for tooling. */
export function createApp(routes: readonly AnyRoute[] = allRoutes): App {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use(idempotency());
  for (const route of routes) mountRoute(app, route);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return Object.assign(app, { routeTable: routes });
}
