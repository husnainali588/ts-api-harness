# sample-orders-api

Small existing orders API, the brownfield target for the harness. Express 5, Zod 4, TypeScript (strict), Vitest.
Written by us because no sample API was provided.

- `createApp()` in `src/app.ts` builds the app; tests start it in-process with supertest.
- Routes under `/v1/orders`: `POST` (201 + `Location`, optional `Idempotency-Key`), `GET` list (`cursor` + `limit`,
  `{ data, nextCursor }`), `GET /:id`, `PATCH /:id`, `DELETE /:id` (204).
- Every non-2xx response is `application/problem+json` (`src/problem.ts`). Malformed JSON → 400, validation → 422.
- In-memory store, no database.

```
npm ci
npm test
npm run typecheck
```
