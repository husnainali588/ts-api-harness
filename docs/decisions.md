# decisions.md — non-obvious decisions, one line each (feeds docs/design.md)

## Inputs (Phase 0b)
- No task file or sample API was provided (only the brief), so we wrote `tasks/users.yaml`, `tasks/orders-add-field.yaml` and `fixtures/sample-api` ourselves.
- Task format uses the brief's own words as top-level keys: `resource`, `fields`, `behaviours` (brief §01 "From a task file (resource, fields, behaviours)"); YAML.
- `fields` is a map of name → `{ type, required?, unique?, generated?, minLength?, maxLength?, min?, max?, values? }`; types `uuid | email | string | integer | datetime | enum`; `generated` = server-assigned, read-only.
- `behaviours` are plain sentences for the model; checks never parse them — status codes and conventions come from the standards rules, uniqueness (409) from `fields.*.unique`.
- A brownfield task is a task with an `api:` key (path to the existing API root); its `fields` lists only the fields being added or changed.
- **`core/task.ts` must stay tolerant of small format differences**, because graders may bring their own task file: accept `.yaml`/`.yml`/`.json`; `behaviours` or `behaviors`; `fields` as a map or a list of `{ name, … }`; type shorthand (`email: string`); singular or plural `resource` (normalised with pluralize); unknown keys kept and passed to the model as text. Adapt the loader, never edit a task file; if one cannot be parsed at all, stop and ask.
- Sample API uses Express 5 + Zod 4 → `templates/api` uses Express 5 too (CLAUDE.md §2: same framework as the sample).
- Sample API is hand-written (plain `Router`, `parseInput`, schema-parsed responses) and does not use the template's `defineRoute`, so rules and the probe are proven on code the harness did not scaffold. It exports `createApp()`.
- Malformed JSON → 400 problem (`malformed-json`); validation (body, query, params, headers) → 422 (`validation`); a malformed path id is a validation failure → 422.
- `Idempotency-Key` on POST is optional but honoured: same key + same body replays status, `Location` and body; same key + different body → 409.
- Cursors encode a monotonic sequence number, not an offset, so pages stay stable across deletes; `page`/`offset` query params are rejected (strict query schema).
- TypeScript pinned to 5.x (`~5.9.3`) although 7.x is npm `latest`: CLAUDE.md §2 says 5.x and ts-morph needs the 5.x compiler API.
- Wrong method on an existing path → 404 problem (Express has no automatic 405); the probe's allowed set for "wrong method" is {404, 405}.
