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
- Each `TurnResponse` also carries `transport` (`native | gateway | local`) and the serving `model` id; `local` = scripted/replayed turns, never evidence.
- Code under `core/`, `plugins/`, `tasks/`, `templates/` cites the design doc as "spec §x", never by file name: the leak test is case-insensitive and the doc's file name contains a provider word.
- Plugin definitions are validated structurally (duck-typed Zod checks), not with `instanceof`, so a plugin loaded from any path or a temp copy validates the same way.
- Drivers declare `envKeys` (any one authenticates) and `envVars` (optional settings) so `harness doctor` can print variable names without core naming any provider.
- Subprocesses get a scrubbed env (names ending `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `_CREDENTIALS` or containing `API_KEY` removed), so model-written tests run by the harness cannot read keys; only harness-owned ship steps keep them.
- `.env` is loaded by the CLI with `process.loadEnvFile`; tests set `HARNESS_NO_DOTENV=1` so they never touch real keys.
- `npx harness` resolves the package's own `bin` (verified with npm 11), so no global link is needed.
- G2 "observed red" = a mapped test case was recorded failing at any earlier point in this run (not necessarily right now), so standards fixes after green don't need a new failing test; every red case must still end green (G3 continuity).
- A test file that fails to load because its import does not resolve yet counts as red (`load-error`, the classic TDD red); a test that fails to load for any other reason (syntax error) does not.
- Mapping is direct imports (static, type-only, re-export, dynamic) + the naming convention, not the transitive import graph: one end-to-end test must not unlock every source file.
- Workspaces symlink `node_modules` from an existing install (template, fixture) instead of `npm ci` per run; `.gitignore` lists `node_modules` without a slash because a symlink is not a directory to git.
- The vitest JSON report is written outside the workspace and parsed by the harness; the in-memory ledger, not the file, is the source of truth (model-written test code runs with filesystem access — see honesty boundary).
- Template handlers return `{ status, body, location? }` typed loosely (TypeScript widens the status literal through the generic); every reply is validated against `responses[status]` at runtime (mismatch → 500) and zod-boundary checks statically that each returned status has a schema.
- Template routes are declared with `defineRoute` and errors are thrown (`NotFound`, `Conflict`, `ValidationProblem`), never returned; the model never touches `req`/`res`.
- `src/routes/index.ts` is harness-generated by the `route-index` post-hook from `src/routes/*.ts` (each module default-exports its routes), so `createApp()` always mounts everything; the model cannot write it (path-guard).
- Rules understand both template `defineRoute({...})` routes and hand-written Express `router.METHOD('/path', …)` routes with `app.use('/prefix', router())` mount prefixes, so greenfield and brownfield share one rule set.
- Implicit-any detection flags any-typed expressions except where the contextual type is `unknown` (e.g. `parseInput(schema, req.body)`, `const x: unknown = JSON.parse(…)`); it runs on src/ only, explicit escapes (`any`, `!`, ts-ignore, eslint-disable) on src/ and test/.
- `rest-conventions` checks 409 only when a task declares unique fields; `harness check --api` accepts `--task` and the run gate always passes the task.
- Rule summaries: ratio rules print "passed/checked unit"; count rules (tsc-strict, no-unsafe-ts) print the failure count ("0 errors").
- problem-probe boots the API in a fresh `node --import tsx` subprocess every time, so code the model just changed is never served from a module cache; it binds 127.0.0.1:0 only.
- problem-probe takes routes and schemas from `createApp().routeTable`; for APIs without one (hand-written Express) it falls back to static route discovery and imports the parsed schemas by export name.
- Probe families and allowed statuses: malformed-json {400}, empty-body {400,422}, missing-field/wrong-type {422}, malformed-id {400,404,422}, unknown-id {404} (+422 with a body), unknown-route {404}, wrong-method {404,405}, list-bounds {400,422}, duplicate {409}, idempotency replay identical + reuse {409}.
- Added rule `task-coverage` (not in the original rule list): G3 had no check that the task was built at all, so finish on the untouched scaffold would pass; it maps behaviour verbs (create/list/get/update/delete) to required routes, and brownfield task fields to schema keys.
- G3 continuity treats a file-level load red as satisfied once that file loads with ≥1 passing case and nothing failing or skipped.

## Drivers (Phase 6) — checked against OpenRouter on 2026-10-05
- OpenRouter Chat Completions: `https://openrouter.ai/api/v1/chat/completions`, `Authorization: Bearer <OPENROUTER_API_KEY>`; usage `prompt_tokens` (already includes cached tokens; `prompt_tokens_details.cached_tokens` is a subset), `completion_tokens`; `tools`/`tool_choice` in OpenAI shape.
- OpenRouter Anthropic-compatible Messages endpoint: base URL `https://openrouter.ai/api` (SDK appends `/v1/messages`), auth `Authorization: Bearer <key>` (SDK `authToken`), model ids `anthropic/<model>`; usage `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` (summed = full input), `output_tokens`.
- Default models exist (public `/api/v1/models`): `anthropic/claude-haiku-4.5` ($1 / $5 per M in/out, 200k ctx, tools) and `openai/gpt-5.4-mini` ($0.75 / $4.50 per M, 400k ctx, tools). Native ids: `claude-haiku-4-5-20251001`, `gpt-5.4-mini`.
- gpt-5.4-mini does not accept `temperature` → never sent; uses `max_completion_tokens`, `reasoning_effort: "low"` (lowest broadly-supported level; spec says reasoning off or lowest). Haiku 4.5: no thinking parameter sent (off by default), `max_tokens` required.
- Both drivers pass base URL and auth explicitly in code; `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` are never read or set.
- Free tool-capable models on OpenRouter today include `google/gemma-4-31b-it:free`, `qwen/qwen3.8-27b:free`, `nvidia/nemotron-3-super-120b-a12b:free` (rehearsal candidates; request-limited).

- Wrong method on an existing path → 404 problem (Express has no automatic 405); the probe's allowed set for "wrong method" is {404, 405}.
