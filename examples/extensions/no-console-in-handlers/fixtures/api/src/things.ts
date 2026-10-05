// Fixture: one clean handler and one that logs to the console.
import { Router } from 'express';

export function thingsRouter(): Router {
  const router = Router();
  router.get('/v1/things', (_req, res) => {
    res.status(200).json({ data: [], nextCursor: null });
  });
  router.delete('/v1/things/:id', (_req, res) => {
    console.log('deleting a thing');
    res.status(204).end();
  });
  return router;
}
