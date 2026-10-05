import { Router } from 'express';
import { IdempotencyKey, IdempotencyStore } from '../idempotency.js';
import { ListQuery, decodeCursor, encodeCursor } from '../pagination.js';
import { NotFound, parseInput } from '../problem.js';
import { CreateOrderBody, Order, OrderIdParams, OrderPage, UpdateOrderBody } from './schemas.js';
import { OrderStore } from './store.js';

export function ordersRouter(store = new OrderStore(), idempotency = new IdempotencyStore()): Router {
  const router = Router();

  router.post('/', (req, res) => {
    const body = parseInput(CreateOrderBody, req.body, 'body');
    const key = parseInput(IdempotencyKey, req.get('Idempotency-Key'), 'headers');
    const scope = `POST ${req.baseUrl}`;
    if (key !== undefined) {
      const replay = idempotency.lookup(scope, key, body);
      if (replay !== undefined) {
        res.status(replay.status).location(replay.location).json(Order.parse(replay.body));
        return;
      }
    }
    const order = Order.parse(store.create(body));
    const location = `${req.baseUrl}/${order.id}`;
    if (key !== undefined) {
      idempotency.save(scope, key, body, { status: 201, location, body: order });
    }
    res.status(201).location(location).json(order);
  });

  router.get('/', (req, res) => {
    const query = parseInput(ListQuery, req.query, 'query');
    const after = query.cursor === undefined ? 0 : decodeCursor(query.cursor);
    const result = store.list(after, query.limit);
    const nextCursor = result.hasMore && result.lastSeq !== null ? encodeCursor(result.lastSeq) : null;
    res.status(200).json(OrderPage.parse({ data: result.orders, nextCursor }));
  });

  router.get('/:id', (req, res) => {
    const { id } = parseInput(OrderIdParams, req.params, 'params');
    const order = store.get(id);
    if (order === undefined) throw new NotFound(`Order ${id} does not exist.`);
    res.status(200).json(Order.parse(order));
  });

  router.patch('/:id', (req, res) => {
    const { id } = parseInput(OrderIdParams, req.params, 'params');
    const patch = parseInput(UpdateOrderBody, req.body, 'body');
    const order = store.update(id, patch);
    if (order === undefined) throw new NotFound(`Order ${id} does not exist.`);
    res.status(200).json(Order.parse(order));
  });

  router.delete('/:id', (req, res) => {
    const { id } = parseInput(OrderIdParams, req.params, 'params');
    if (!store.delete(id)) throw new NotFound(`Order ${id} does not exist.`);
    res.status(204).end();
  });

  return router;
}
