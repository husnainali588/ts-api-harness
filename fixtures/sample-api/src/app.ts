import express, { type Express } from 'express';
import { ordersRouter } from './orders/routes.js';
import { errorHandler, notFoundHandler } from './problem.js';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  app.use('/v1/orders', ordersRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
