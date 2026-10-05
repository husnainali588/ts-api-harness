# progress.md — source of truth for the AUTORUN build

Re-read `CLAUDE.md`, `docs/AUTORUN.md` and this file before each phase.

## Phase 0b — own task files + sample API

Plan:
1. `tasks/users.yaml` (greenfield): top-level `resource`, `fields`, `behaviours` (brief §01 wording); five behaviours:
   create, get by id, list (cursor), update (PATCH, partial), delete → exercises 201/204/404/409/422.
2. `tasks/orders-add-field.yaml` (brownfield): same keys plus `api: fixtures/sample-api`; adds optional `notes`.
3. `fixtures/sample-api`: hand-written Express 5 + Zod 4 + TS 5.9 orders API, already standards-compliant,
   `createApp()` export, in-memory store, one test file per source file, committed lockfile.
4. `docs/decisions.md`: task-format decisions, incl. "core/task.ts must stay tolerant of small format differences".
5. `README.md`: we wrote the tasks + sample API ourselves (none provided); a grader can drop a task file into `tasks/`.
6. Verify: sample API `npm ci`, `npm test`, `npm run typecheck` green; YAML parses; no provider words in `tasks/`.

Result: DONE — commit `7411458`, pushed.
- Built: both task files, `fixtures/sample-api` (7 source files, 7 test files, lockfile), `docs/decisions.md`, `README.md`.
- Tests: sample API typecheck clean; vitest 7 files / 60 tests passed. No provider words in `tasks/`.
- Root `npm test` / typecheck / leak test: n/a (no harness code yet; they start in Phase 1).
- UNPROVEN: YAML parse of the task files (moved to Phase 1 loader tests); `.env.example` empty values (could not read it — see QUESTIONS.md).

## Phase 1 — skeleton and contracts

Plan:
1. Root `package.json` (ESM, `bin.harness` → `bin/harness.mjs` registering tsx then importing `core/cli.ts`; scripts
   setup/test/typecheck), strict `tsconfig.json` (§1.9 flags + `exactOptionalPropertyTypes`), `vitest.config.ts`.
2. `core/driver.ts` per §5.1 (+ `transport`/`model` on each response). `core/sdk.ts`: `defineTool/Rule/Hook/Context/Driver`,
   each validated with Zod (duck-typed, so plugins loaded from any path validate). `core/registry.ts`: discovers
   `plugins/{tools,hooks,rules,context}/*/index.ts` + `drivers/*/index.ts`, skips `_*`, honours optional
   `plugins/registry.json` (`disabled`, `order`, `extraPaths`), throws with the plugin path on a broken plugin.
3. `core/task.ts`: tolerant loader around our task format (yaml/yml/json, behaviours|behaviors, map|list fields,
   shorthand types, nested resource, extra keys kept) → normalised task + sha256.
4. `core/cli.ts`: `harness plugins`, `harness doctor` (node, git, gh, per-driver env key names set/missing — names only).
   `.env` loaded with `process.loadEnvFile`, skipped when `HARNESS_NO_DOTENV=1` (tests).
5. `drivers/scripted`: JSONL script of turns → tool calls; usage `estimate` (chars/4).
6. `_template` folder for every plugin kind and for drivers.
7. Tests: registry (temp copy under `.harness/tmp`), `_` ignored, broken plugin path, task loader (both task files +
   tolerant variants), scripted driver, CLI plugins/doctor, `test/no-provider-leak.test.ts`.

Result: DONE — see commit "feat(core): skeleton, driver contract, registry".
- Built: package.json/tsconfig/vitest config, bin/harness.mjs, core/{driver,sdk,registry,task,cli,exec}.ts,
  drivers/scripted, `_template` for tools/hooks/rules/context/drivers, scripts/setup.mjs.
- Tests: `npm test` 5 files / 34 tests passed; `npm run typecheck` clean; leak test green.
- Done-when: `npx harness plugins` lists `scripted  drivers/scripted/index.ts`.
- Task YAML parse (left UNPROVEN in 0b) now proven by test/task.test.ts.
- Commit `2bcbced`, pushed.

## Phase 2 — loop, hooks, file tools, G1

Plan:
1. `core/workspace.ts`: git worktree per run under `.harness/worktrees/<runId>` on `harness/<task>-<driver>-<short>`;
   API root = `generated/<resource>-api` (greenfield) or the task's `api` path (brownfield); realpath-safe resolution.
2. `core/redact.ts` (env secret values + key-format regexes); `core/state.ts` (run state + evidence writer: events.jsonl,
   transcript, raw/, summary.json with fingerprint of task + plugins/hooks + plugins/rules).
3. `core/hooks.ts`: pre/post pipeline, fail-closed on hook crash, every decision logged with exit 0/1/2.
4. `core/loop.ts` per §5.2 (one call at a time, nudge once, turn budget, consecutive-block stop); `core/context.ts`
   (system prompt, state card); `core/tokens.ts` ledger; `harness run` command.
5. Tool plugins: list_files, read_file, search_code, write_file, edit_file, add_dependency, get_task, finish.
6. Hook plugin `path-guard` (G1): workspace-only paths for reads and writes, no traversal/absolute/symlink escape,
   protected files (package.json, tsconfig*, test-runner and eslint config, .git, .harness, node_modules).
7. Gate tests with the scripted driver for every G1 bypass; loop test proves events.jsonl has exits 0/1/2.

Result: DONE — commit "feat(core): loop, hooks, worktree, file tools, G1 path guard".
- Built: core/{loop,hooks,workspace,state,redact,context,tokens}.ts, `harness run`; 8 tool plugins; hooks path-guard (G1)
  and write-log (record, exit 1).
- Tests: 10 files / 85 tests passed; typecheck clean; leak test green. 22 G1 bypass attempts blocked with reason + fix.
- Done-when: scripted run writes `src/hello.ts` inside the worktree; traversal and protected writes blocked; events.jsonl
  shows exits 0/1/2 (test/loop.test.ts).
- Note: the finish gate is a placeholder that is never green until Phase 5 wires G3 (runs end UNPROVEN, by design).
- Note: core is 1,685 lines incl. comments and type declarations — over the 1,500 soft target (QUESTIONS.md).
- Commit `ca16d72`, pushed.

## Phase 3 — test runner, observations, observed red (G2)

Plan:
1. `core/tests.ts`: run vitest in the API root as a subprocess (JSON reporter, report file outside the workspace),
   parse per-test-case observations (file, full name, status, failure kind, test-file sha256, turn), write
   `.harness/runs/<id>/observations.json` (only via run_tests); keep every red case ever seen for G3.
2. Import-failure loads (`Cannot find module …`) count as red (`load-error`); syntax errors in a test do not.
3. Source↔test map with ts-morph from import specifiers (static, type-only, re-export, dynamic) — resolves before
   the source exists — plus the `src/x/y.ts` ↔ `test/x/y.test.ts` convention.
4. Tool `run_tests` (compact PASS/FAIL summary, raw to disk); hook `observed-red` (G2) on src/ writes.
5. Workspaces get `node_modules` by symlinking an existing install (template / fixture), else `npm ci`.
6. `templates/api` base (package.json, lockfile, strict tsconfig, vitest config) so greenfield runs can test.
7. Gate tests: source before test; test never run; test seen green not red; test + source same turn; syntax-error
   "red"; honest TDD cycle (load-error red and assertion red); mapping through imports.

Result: DONE — commit "feat(core): test runner, observations, observed-red gate (G2)".
- Tests: 12 files / 102 tests passed; typecheck clean; leak test green.
- Done-when: all G2 bypass tests blocked; scripted honest cycle test → red → source → green passes.
- Commit `defa674`, pushed.

## Phase 4 — standards rules, `harness check`, greenfield template

Plan:
1. `templates/api`: Express 5 + Zod 4 scaffold — `createApp()` exposing `routeTable`; `defineRoute({ method, path, params,
   query, body, responses, handler })` parsing every input and validating the reply against `responses[status]`;
   problem() + Problem schema; 404 catch-all, malformed JSON → 400, validation → 422, NotFound/Conflict, unknown → 500
   without stack; cursor codec + page schema; idempotency middleware; in-memory store; tests for every file.
   `src/routes/index.ts` is harness-generated from `src/routes/*.ts` (post-hook `route-index`; model writes blocked).
2. `core/checks.ts`: rule runner with the type checker, `npm ci --ignore-scripts` when node_modules is missing
   (failure → unproven), one line per rule per file, summary block, verdict, exit code, reports/<id>/standards.{txt,json};
   `harness check --api <path> [--task <file>]`; tool `run_checks`.
3. Rule plugins: zod-boundary, problem-json, tsc-strict, no-unsafe-ts, rest-conventions, tests-mapped — understanding
   both template `defineRoute` routes and hand-written Express routers (shared helpers in `plugins/rules/_shared`).
4. `test/fixtures/good-api`: hand-made users API on the template → 100%. Sample API also 100% (non-template code).
5. Tests: per rule, a mutation of good-api that must FAIL at the right file:line, and the good one passing; the scaffolded
   template prints only pass/n/a and 100%.

Result: DONE — commit "feat: standards rules, harness check, greenfield template".
- Built: core/checks.ts, `harness check`, tool run_checks, hook route-index, 6 rule plugins + `_shared` analysis,
  templates/api (7 source files, 7 test files, 34 tests), test/fixtures/good-api (users, 44 tests).
- Tests: 14 files / 118 tests passed; typecheck clean; leak test green.
- Done-when: `npx harness check --api test/fixtures/good-api` → verdict 100%, exit 0; every rule's bad mutation fails with
  file:line (test/rules.test.ts); template → only pass/n/a, 100%; sample API (hand-written Express) → 100%.
- Scripted greenfield run on the real template reaches run_checks 100% through G1/G2 (test/greenfield.test.ts).
- Commit `d71dbfa`, pushed.

## Phase 5 — problem-probe (our addition) + finish gate (G3)

Plan:
1. Rule plugin `problem-probe` (required): a fresh subprocess (tsx) imports the API's `createApp()`, reads `routeTable`
   (fallback: AST routes with schemas imported by export name; neither → unproven), boots it on 127.0.0.1:0 and
   sends schema-generated requests: malformed JSON, empty body, each required field missing, each field wrong type,
   malformed/unknown ids, unknown route, wrong method, limit=0/10000, garbage cursor, duplicate unique field,
   idempotency replay + key reuse. Every non-2xx must be problem+json, parse as a Problem, status = HTTP status,
   instance = path, no stack trace, status in the family's allowed set. One line per family per route; transcript
   to runs/<id>/raw.
2. `core/finish.ts` (G3): full suite green via the harness runner; red→green continuity for every red case;
   strict tsc + `harness check` at 100% with zero unproven required rules; failing lines back to the model.
3. Tests: probe passes on good-api and the sample API; fails when (a) the 404 catch-all, (b) the malformed-JSON
   handler, (c) the problem+json media type, (d) `instance` is removed. G3: finish rejected with a failing rule,
   a deleted red test, a skipped red test, an unproven rule; honest run green.

Result: DONE — commit "feat: problem-probe gate + finish gate".
- Built: plugins/rules/problem-probe (index + subprocess runner), core/finish.ts (G3, wired as the loop's default gate),
  plugins/rules/task-coverage (added: without it, finishing on the untouched scaffold would have been green).
- Probe: good-api 25/25 probes, sample API 25/25 (static-route fallback); fails on (a)–(d); UNPROVEN when unbootable.
- Tests: 16 files / 133 tests passed; typecheck clean; leak test green.
- Commit `23dd318`, pushed.

## Phase 6 — real drivers, smoke test, rehearsal

Plan:
1. Verify OpenRouter docs + model list first; record in docs/decisions.md.
2. drivers/claude (Messages format; native key or OpenRouter `https://openrouter.ai/api` with Bearer auth) and
   drivers/openai (Chat Completions; native or `https://openrouter.ai/api/v1`); retries; usage incl. cache; transport +
   served model per turn. Recorded-fixture tests for all four combinations.
3. Spend ledger `.harness/spend.json`, `--max-run-tokens` / `--total-budget` (flags override env), effective cap =
   min(per-run, remaining), refuse under 20,000 remaining, cap stop = UNPROVEN with evidence, `:free` not counted.
4. Replay of recorded transcripts with the scripted driver.
5. Live: smoke each driver (--max-turns 3), then one free rehearsal on the openai driver.

Result: PARTLY DONE — offline part commit `0bef81f`, blocked-key note `150480b`.
- Tests: 18 files / 149 tests passed; typecheck clean; leak test green.
- Live runs (both with `--max-run-tokens 150000 --total-budget 650000`):
  | run id | driver | model | input | output | ledger total | est. cost |
  |---|---|---|---|---|---|---|
  | 20261005083744-25f7f1 | claude | anthropic/claude-haiku-4.5 | 0 | 0 | 0 | $0 |
  | 20261005083903-4a896f | openai | openai/gpt-5.4-mini | 0 | 0 | 0 | $0 |
  Both: `401 Missing Authentication header` on the first request — OpenRouter returns the same for an invalid token.
- BLOCKED: smoke tests and the free rehearsal need a valid OPENROUTER_API_KEY in `.env` (QUESTIONS.md).

## Phase 7 — JIT context, compaction, baseline, token report

Plan:
1. Context plugins standards (`get_standard`), schemas (`get_schema`), task (`get_task` sections), each with fetch() +
   frontLoad().
2. core/context.ts + loop: baseline front-loads API root files + task + all frontLoads (refreshed each turn), raw tool
   results, no compaction; actual keeps 6 exchanges, stubs older results, elides old tool-call payloads.
3. `harness bench` → tokens/<runId>.json from ledgers only, `--baseline-turns`, `--actual-run` (same task sha + driver).
4. Test bench offline with the scripted driver; replay a scripted greenfield session (stand-in for the blocked
   rehearsal) in both modes; fix fattest turns if under 90%.

Result: DONE with an open finding — commit `fa489dd`.
- Tests: 19 files / 154 tests passed; typecheck clean; leak test green.
- Offline estimate (chars/4, not evidence): 80.3% mean per turn over aligned turns 1–8; 82.3% over the full 14-turn
  script. Eaten by ~1.2k fixed tokens per turn on both sides (tools, prompt, brief) while early history is the same on
  both sides; trimmed tool definitions and schema noise; window kept at 6 (QUESTIONS.md).

## Phase 8 — brownfield

Plan:
1. Run start (brownfield): existing tests must be green (else UNPROVEN "baseline red", no turns); snapshot
   contract.before.json (route table + request/response JSON Schemas, via a fresh tsx subprocess), findings.before.json,
   map.json into `.harness/runs/<id>/`.
2. Tool `propose_scope({ files, reason })`: accepts files reachable from the task's resource in the import graph (plus
   their tests) or new files beside them; rejects others with the allowed list. Hook `scope-guard` enforces it.
3. Finish additions: ratchet (no new findings vs before, touched files clean) and contract gate (no removed
   route/field/status, narrowed type, new required request field, removed enum value); additive changes recorded.
4. Tests: response field removed → contract FAIL; new finding in an untouched file → ratchet FAIL; out-of-scope write
   blocked; an honest scripted change (optional `notes`) ends with G3 green.

Result: DONE — commit "feat(core): brownfield scope, ratchet and contract gates".
- Moved shared route analysis to core/analysis.ts (used by rules and by the contract gate); probe uses routeRefs.
- Tests: 20 files / 160 tests passed; typecheck clean; leak test green.
