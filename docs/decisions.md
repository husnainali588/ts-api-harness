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

## Context and tokens (Phase 7)
- Baseline (exact definition for the design note): same task, same driver, same tools; the system prompt front-loads every text file under the task's API root (no node_modules, no lockfiles), the task file, and every context plugin's `frontLoad()` (standards docs, all schemas, the task), refreshed every turn so it reflects the workspace; tool results are raw; no history compaction.
- Actual: ~220-token system prompt; first message = task brief + state card re-rendered every turn; tools return summaries (raw to `runs/<id>/raw/`); last 6 exchanges verbatim, older tool results become one-line stubs and older large tool-call inputs are dropped (`_elided` note); long files read without a range return an outline; unchanged re-reads return "unchanged since turn N".
- **Core change after the freeze (approved by the user, Phase 12):** core/context.ts no longer shortens tool-call inputs inside the 6-exchange window (back to the spec: last 6 exchanges verbatim). In older exchanges, large string fields of tool-call inputs are dropped and replaced by one `"_elided": "<N> chars, already applied"` field — no placeholder text is left where content was. Why: in paid runs 20261005094610-7b015f and 20261005100426-810aa6, Claude Haiku 4.5 imitated the earlier marker `"[N chars elided from history]"` and wrote it as file content (even for files it had never written), which cost both runs their budget. `placeholder-guard` (hook) also blocks any write that still contains such a marker. Test: test/context.test.ts proves no elided text inside the window.
- Token report is computed only from the two runs' ledgers (`runs/<id>/tokens.json`); reductions use the aligned turns when the baseline is capped and say so in `note`; `bench` refuses a local (scripted) driver unless `--offline`, and such reports are marked `evidence: false`.

## Brownfield (Phase 8)
- Scope = files reachable from the target resource: seeds are src/ files whose path names the resource (plural or singular), plus their relative-import closure, plus tests that import any of them; new files are allowed only in a directory of a resource-named file. Shared modules the resource imports (e.g. problem.ts) are therefore in reach, unrelated modules are not.
- Contract snapshot reads `createApp().routeTable` when present, otherwise static routes with their parsed and sent schemas imported by export name; JSON Schemas use `io: input` for requests and `io: output` for responses. Snapshots run in a fresh tsx subprocess like the probe.
- Ratchet compares findings by rule + file + message (not line), so moving code is not a new finding; `task-coverage` is excluded (it is expected to change).
- The existing suite's baseline results never count as red: only cases that fail after the model's own writes unlock source edits.
- Scope enforcement moved from path-guard into its own hook, `scope-guard` (G1 extension), so path-guard stays about paths.

## Drivers (Phase 6) — checked against OpenRouter on 2026-10-05
- OpenRouter Chat Completions: `https://openrouter.ai/api/v1/chat/completions`, `Authorization: Bearer <OPENROUTER_API_KEY>`; usage `prompt_tokens` (already includes cached tokens; `prompt_tokens_details.cached_tokens` is a subset), `completion_tokens`; `tools`/`tool_choice` in OpenAI shape.
- OpenRouter Anthropic-compatible Messages endpoint: base URL `https://openrouter.ai/api` (SDK appends `/v1/messages`), auth `Authorization: Bearer <key>` (SDK `authToken`), model ids `anthropic/<model>`; usage `input_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` (summed = full input), `output_tokens`.
- **Claude driver default changed to Claude Sonnet 5.5** (`anthropic/claude-sonnet-5.5` via OpenRouter, $2 / $10 per M in/out, 1M ctx, tools; native `claude-sonnet-5-5`) after Claude Haiku 4.5 failed all three paid greenfield runs (cost cap each time: placeholder writes, an uninstalled `uuid` import, invented helpers). **This default is not verified live**: the budget was stopped before any Sonnet run. Graders run our defaults; `HARNESS_CLAUDE_MODEL` overrides it. The openai default (GPT-5.4 Mini) passed its live smoke test but never ran a full task.
- Original defaults (public `/api/v1/models`): `anthropic/claude-haiku-4.5` ($1 / $5 per M in/out, 200k ctx, tools) and `openai/gpt-5.4-mini` ($0.75 / $4.50 per M, 400k ctx, tools). Native ids: `claude-haiku-4-5-20251001`, `gpt-5.4-mini`.
- gpt-5.4-mini does not accept `temperature` → never sent; uses `max_completion_tokens`, `reasoning_effort: "low"` (lowest broadly-supported level; spec says reasoning off or lowest). Haiku 4.5: no thinking parameter sent (off by default), `max_tokens` required.
- Both drivers pass base URL and auth explicitly in code; `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` are never read or set.
- Free tool-capable models on OpenRouter today include `google/gemma-4-31b-it:free`, `qwen/qwen3.8-27b:free`, `nvidia/nemotron-3-super-120b-a12b:free` (rehearsal candidates; request-limited).

- Wrong method on an existing path → 404 problem (Express has no automatic 405); the probe's allowed set for "wrong method" is {404, 405}.
