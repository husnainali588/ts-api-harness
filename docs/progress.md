# progress.md — source of truth for the AUTORUN build

Build log, kept as written during the build. The build instructions it refers to (AUTORUN, BUILD_PROMPTS, the
assignment brief) were removed from the repository before submission; how the harness works is in `docs/design.md`.

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
- UNBLOCKED after Phase 11 (keys fixed by the user). `harness doctor`: claude and openai drivers both "ready — set:
  OPENROUTER_API_KEY"; OPENAI_API_KEY is **not** visible to the harness, so the openai driver uses the gateway.
  Re-run at the user's request (same caps `--max-run-tokens 150000 --total-budget 650000`):
  | run id | driver | model (served) | transport | input | output | ledger total | est. cost |
  |---|---|---|---|---|---|---|---|
  | 20261005093629-ad605f | claude | anthropic/claude-haiku-4.5 | gateway | 8,841 | 3,100 | 8,841 | ≈ $0.024 ($1/$5 per M) |
  | 20261005093703-f0f8d8 | openai | openai/gpt-5.4-mini | gateway | 8,896 | 358 | 17,737 | ≈ $0.008 ($0.75/$4.50 per M) |
  Both UNPROVEN by design (3-turn cap) with valid tool calls: claude get_task/get_standard ×3/list_files/write_file
  (a users test first); openai get_standard/get_task/list_files/read_file ×8.
- Free rehearsal `20261005093822-7f9bba` (openai driver via gateway, `qwen/qwen3.8-27b:free`, `OPENAI_API_KEY=` for that
  command only): stopped at turn 6 by `429 Provider returned error` after the SDK's 5 retries — free tier rate limit.
  39,168 input / 5,706 output tokens, free (not counted; ledger stays 17,737). Not retried (AUTORUN §4: skip if
  rate-limited). Its 6-turn transcript replays through the scripted driver with the identical tool sequence.
- Finding from the live transcript: actual input grew 1.7k → 10k tokens in 6 turns because the model read whole
  template files. Fix (plugin, core untouched): read_file without a range on files > 60 lines returns an outline
  (top-level declarations + line numbers) and asks for a range; raw full text still goes to disk / to the baseline.
  Offline bench on that real transcript: 74% mean per turn over turns 1–6 (was ~65% at turn 6 before the outline).
  Run ids (scripted, offline): rehearsal replay `20261005094139-316ec7`, replay with outlines `20261005094230-04fde1`,
  bench actual `20261005094243-c48fd3` / baseline `20261005094244-3b8f66`.

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
- Commit `c888d01`, pushed.

## Phase 9 — ship step (G4)

Plan:
1. core/ship.ts: preconditions (green G3, nothing unproven, not baseline), protected-branch refusal (main, master,
   develop, trunk, release/*, prod*, remote default), evidence copied into the branch, selective staging (API output or
   brownfield written files + runs/reports/tokens of the run; never `add -A`; node_modules always excluded), staged-diff
   secret scan (key regexes + literal env secret values), commit with gate summary, `push -u`, `gh pr create
   --body-file runs/<id>/pr.md`, PR URL into summary.json. git via execFile arrays; no --force/--no-verify.
2. `harness ship --run <id>` and `harness run --ship`.
3. Bare-repo tests; then a scripted greenfield run + --ship against the real GitHub repo, then close that PR.

Result: DONE — commit "feat(core): ship step with G4 preconditions".
- Tests: 21 files / 166 tests passed; typecheck clean; leak test green.
- Real PR proof: scripted run `20261005090611-08390b` (GREEN through the real G3) shipped
  https://github.com/husnainali588/ts-api-harness/pull/1 — 34 files, all under generated/users-api/, runs/, reports/;
  closed with a comment and its remote branch deleted (evidence PRs come from Phase 12).
- Found and fixed during the bare-repo test: a symlinked node_modules was staged when the target repo's .gitignore only
  had `node_modules/` → ship now excludes node_modules by pathspec regardless of .gitignore.

## Phase 10 — freeze core, prove extensibility

Plan:
1. Core frozen from here (any core change = extension-point problem → ask).
2. examples/extensions/: tool `openapi_diff` (+ two OpenAPI fixtures), rule `orm-explicit-columns` (Prisma
   findMany/findFirst/findUnique without select; Drizzle select() without columns .from(users), query.users.findMany
   without columns; fixture with one good, one bad query), linter rule `no-console-in-handlers` (+ fixture).
3. scripts/extension-demo.sh: per example → copy into plugins/, `git add -N`, `git diff --stat`, assert only that
   plugin folder changed and nothing under core/, run `harness plugins` + `harness check --api <fixture>`, remove.
4. test/extensibility.test.ts: the same in a temp git copy. docs/extending.md: one section per plugin kind.

Result: DONE — commits "feat(examples): three drop-in extensions and the extension demo" + "test: extensibility".
- scripts/extension-demo.sh passes all three: `git diff --stat` shows only `plugins/<kind>/<name>/index.ts`, core/
  untouched; each listed by `harness plugins`; rules print their own FAIL lines with file:line:col
  (orm-explicit-columns 3/5 queries, no-console-in-handlers 1/2 handlers) and summary lines.
- Tests: 22 files / 170 tests passed; typecheck clean; leak test green (now also scans examples/).
- Core is frozen from here.

## Phase 11 — red team

Plan: script adversarial attempts with the scripted driver beyond CLAUDE.md §6; fix each that works with the cheapest
mechanism (plugins, core frozen); add each as a regression test; report in docs/redteam.md.

Result: DONE — commit "fix(gates): red-team fixes".
- 15 attempts (docs/redteam.md); 8 worked before the fixes: vacuous test, weakening a red test after the source write,
  source via src/*.test.ts, code outside src/, .js files, editing template infrastructure / template tests, computed
  route paths, `as unknown as T`. Fixed with: rule `test-assertions`, hook `red-test-lock`, observed-red (tests under
  test/, code under src/, .ts only), path-guard (template-owned files in greenfield), zod-boundary (computed paths),
  no-unsafe-ts (double assertions). No core file changed.
- Tests: 23 files / 182 tests passed; typecheck clean; leak test green; good-api, sample API, template still 100%.

## Phase 12 — evidence, grader simulation, design note

Plan:
1. Paid runs, each once, in order, with `--max-run-tokens 150000 --total-budget 650000`: greenfield claude --ship;
   greenfield openai; brownfield (claude) --ship; `bench --baseline-turns 8 --actual-run <greenfield claude runId>`.
   After each: run id, model, tokens, ledger, cost here. Failure → diagnose by replay, fix, STOP and ask before re-run.
2. Commit evidence (runs/, reports/, tokens/ of those runs; the generated API to generated/users-api).
3. scripts/grade.sh offline must pass; docs/design.md with numbers copied from harness-written files; README evidence.

Paid run 1 — greenfield `--driver claude --ship`:
| run id | driver | model (served) | transport | turns | input | output | ledger total | est. cost |
|---|---|---|---|---|---|---|---|---|
| 20261005094610-7b015f | claude | anthropic/claude-haiku-4.5 | gateway | 27 | 147,536 | 8,459 | 165,273 | ≈ $0.19 ($1/$5 per M) |
Result: UNPROVEN — `stopped by cost cap (147536 spent + ~5193 next turn > 150000 input tokens)`; not shipped.
Diagnosis (replay `20261005095226-8a4a7a`, free):
- Turns 13–22: the model wrote history placeholders as file content (`src/schemas/user.ts` = "[704 chars elided from
  history]", `src/routes/users.ts` = "[9387 chars elided …]") — it copied the compaction marker from its own earlier
  write calls. ~8 turns (~45k tokens) lost.
- Turn 26: it imported the `uuid` package (not installed) → app failed to load.
- Turns 1–6 were reads (as designed), turn 9 red (404) as expected for TDD.
Fixes (plugins only, core untouched), commit "fix(hooks): placeholder-guard":
- hook `placeholder-guard` blocks writes containing history placeholders, with a fix line; replay of the paid
  transcript now blocks all three placeholder writes (turns 13, 19, 21).
- template doc: installed packages listed; ids via `node:crypto` randomUUID.
- Tests: 24 files / 186 tests passed; typecheck clean; leak test green.

STOPPED: paid run 1 (greenfield claude) hit its cost cap and needs a re-run (AUTORUN §6). Needed from you:
1. Approval to re-run `npx harness run --task tasks/users.yaml --driver claude --ship --max-run-tokens 150000
   --total-budget 650000` — estimated ≤ $0.20 (cap 150k input at $1/M + ~10k output at $5/M).
2. A budget decision: 484,727 tokens remain of 650,000. The remaining plan at full caps is claude re-run (≤150k) +
   openai greenfield (≤150k) + brownfield (≤150k) + bench with 8 baseline turns (~8 × 15–18k ≈ 130k) ≈ 580k, so the
   current total budget may not cover everything if runs go long. Options: raise `--total-budget` (e.g. 800,000,
   ≈ +$0.15 worst case) and/or `--max-run-tokens` to 200,000 for greenfield (27 turns used 148k; a green run likely
   needs 20–30 turns); or keep the caps and accept that a later run may be refused for budget.
3. Optional: OPENAI_API_KEY is not visible to the harness (doctor shows only OPENROUTER_API_KEY for the openai driver);
   the openai evidence will say transport "gateway" unless that is fixed.

RESUMED with the user's answers: (1) re-run approved; (2) caps: `--total-budget 800000` everywhere, `--max-run-tokens
200000` for the greenfield runs, 150000 for brownfield and the bench — anything else failing or exceeding → stop and
ask; (3) openai driver stays on OpenRouter (gateway), stated in the design note's honesty section; native path
covered by recorded-fixture tests; (4) an empty, untracked `api-harness/` folder at the repo root (not created by the
harness) — leave it alone, never read or commit it until the user answers.

Paid run 1b — greenfield `--driver claude --ship --max-run-tokens 200000 --total-budget 800000` (approved re-run):
| run id | driver | model (served) | transport | turns | input | output | ledger total | est. cost |
|---|---|---|---|---|---|---|---|---|
| 20261005100426-810aa6 | claude | anthropic/claude-haiku-4.5 | gateway | 30 | 199,928 | 7,459 | 365,201 | ≈ $0.24 |
Result: UNPROVEN — `stopped by cost cap (199928 spent + ~6575 next turn > 200000 input tokens)`; not shipped.
Diagnosis: placeholder-guard blocked placeholder writes at turns 13 and 16 as designed, but at turn 16 the model's
**first** attempt at src/routes/users.ts was itself a placeholder ("[10098 chars elided from history]") — it imitates
the shortened tool-call inputs it sees in its own history, even for files it never wrote. After that block it never
produced the routes file and spent turns 17–30 reading files (8–10k tokens per turn). Root cause is the Phase 7
compaction that elides large tool-call inputs from every exchange except the latest (core/context.ts), which goes
beyond the spec's "keep the last 6 exchanges verbatim".
Runs so far in Phase 12 cost ≈ $0.43 total (ledger 365,201 of 800,000; 434,799 left).

STOPPED: paid run 1b failed (cost cap). The fix is a core change (core is frozen since Phase 10), so it needs approval.
Needed from you:
1. Approve a small core change in core/context.ts: stop eliding tool-call inputs inside the 6-exchange window (keep
   the spec's window verbatim, elide only older exchanges), and render elided inputs without a copyable placeholder
   string (drop the large field and add `"_elided": "<N> chars, already applied"`), so the model has nothing to
   imitate as content. Expected effect: no placeholder writes; somewhat higher per-turn tokens inside the window.
2. Then approve one more claude greenfield run with the same caps (≤ 200k input ≈ ≤ $0.25). Alternatives: switch
   `--driver claude` to Claude Sonnet 5.5 via HARNESS_CLAUDE_MODEL (≈ 3× the price per token; more reliable tool use;
   MODEL_UPGRADE is "ask"), or keep Haiku.
3. Budget check: 434,799 left; remaining plan = claude greenfield (≤200k) + openai greenfield (≤200k) + brownfield
   (≤150k) + bench (≤150k) = ≤700k at caps → the 800k total no longer covers every run at its cap.

RESUMED (user): (1) core/context.ts change approved and made — window verbatim, older large inputs dropped with an
`_elided` note; test added; recorded in decisions.md; 24 files / 187 tests green. (2) re-run with Haiku; if it fails,
one final attempt with Claude Sonnet 5.5 via HARNESS_CLAUDE_MODEL (pre-approved); if that fails, stop. (3) caps:
`--total-budget 1200000`; per-run 200000 greenfield, 150000 brownfield and bench. (4) `git ls-files api-harness`
prints nothing; it is in no commit; it will never be committed.

Paid run 1c — greenfield claude (Haiku), caps 200000 / 1200000:
| run id | driver | model (served) | transport | turns | input | output | ledger total | est. cost |
|---|---|---|---|---|---|---|---|---|
| 20261005101157-abd57c | claude | anthropic/claude-haiku-4.5 | gateway | 29 | 195,373 | 8,332 | 560,574 | ≈ $0.24 |
UNPROVEN (cost cap). No placeholder writes after the core fix; it imported `uuid` again and invented `PaginatedList`.

CHANGE OF PLAN (user): no more paid runs (keys removed from .env); deliver with what exists, honestly.
- Free fixes: hook `import-guard` (blocks imports of packages not in the API's package.json; points to node:crypto
  randomUUID), `get_standard exports` (real exported helper names). Replays of the three failed Haiku runs
  (`20261005104317-6c530e`, `…104330-4a29b2`, `…104335-bb9486`) show placeholder-guard firing at turns 13/19/21 and
  13/16, import-guard at turns 16/22 and 15 (the write that broke run 3).
- Claude driver default → Claude Sonnet 5.5 (not verified live; decisions.md).
- Free evidence: scripted greenfield `20261005104836-119e72` GREEN, shipped as PR #2 (kept open, retitled "[SCRIPTED
  DRIVER — not a live model] …"); `harness check` on its API → 100% (problem-probe 25/25,
  reports/check-20261005105215-10cef9); scripted brownfield `20261005104956-3ed10f` GREEN (ratchet pass, contract pass,
  6 additive notes changes); offline bench `tokens/20261005105034-a7da99.json` (evidence: false, 80.6% mean/turn);
  `tokens/live-runs.json` (real per-turn numbers of every live run).
- grade.sh prints UNPROVEN for missing live evidence → 4 PASS, 3 UNPROVEN, 0 FAIL.
- docs/design.md and README written with the honest summary.

## Done

**What was built, phase by phase**
- 0b: our own task files (greenfield users, brownfield orders + notes) and a hand-written Express 5 + Zod 4 sample API.
- 1: driver contract, plugin SDK with Zod-validated `define*`, auto-discovering registry, tolerant task loader, CLI
  (`plugins`, `doctor`), scripted driver, `_template` folders, provider-leak test.
- 2: loop, pre/post hook pipeline (exit 0/1/2), git worktree per run, redaction, evidence writer, file tools, G1.
- 3: governed vitest runner, observations, ts-morph source↔test map, `run_tests`, G2 observed red.
- 4: standards rules (zod-boundary, problem-json, tsc-strict, no-unsafe-ts, rest-conventions, tests-mapped),
  `harness check`, greenfield template, reference good-api at 100%.
- 5: problem-probe (our addition), G3 finish gate, task-coverage rule.
- 6: claude (Messages) and openai (Chat Completions) drivers, native + gateway transports, spend ledger and caps.
- 7: JIT context plugins, compaction, baseline mode, `harness bench`.
- 8: brownfield: green baseline, contract/findings snapshots, `propose_scope` + scope-guard, ratchet, contract gate.
- 9: ship step (G4) with a real PR proven end to end.
- 10: three drop-in extensions, extension demo, extensibility test, docs/extending.md; core frozen.
- 11: red team — 15 attempts, 8 fixed with plugins (docs/redteam.md).
- 12: live smoke tests, three failed Haiku greenfield runs + fixes, free scripted evidence, grade.sh, design note.

**Key numbers (from harness-written files)**
- Standards: scripted greenfield API 100% (9 rules, problem-probe 25/25) — reports/check-20261005105215-10cef9; good-api,
  sample API and template 100% (tests).
- Tokens: offline estimate 80.6% mean per-turn reduction over turns 1–8 (evidence: false; target >90% not met); live
  actual-mode means 2,947–6,737 input tokens per turn (tokens/live-runs.json). No evidence-grade reduction exists.
- Live spend: 560,574 input + 27,708 output tokens over five paid runs ≈ $0.70 (ledger `.harness/spend.json`).
- Tests: 25 files / 191 tests; grade.sh 4 PASS, 3 UNPROVEN, 0 FAIL.

**Pull requests**
- https://github.com/husnainali588/ts-api-harness/pull/1 — **public repo**, open, opened by the harness's ship step
  from scripted run `20261005111042-d31bf6`, titled as a scripted-driver run.
- Earlier PRs live in the private repo `husnainali588/ts-api-harness-private`: #2 (open, scripted run
  `20261005104836-119e72`) and #1 (Phase 9 proof, closed). Links to `ts-api-harness/pull/…` above this section were
  written before the move and refer to that private repo.

## Publication

- The original repo was renamed to `ts-api-harness-private` and kept private and untouched (its `submission` tag,
  branches and PRs unchanged; local remote `private`).
- Local `main` was rewritten with `git filter-branch` so `docs/assignment/`, `docs/AUTORUN.md` and
  `docs/BUILD_PROMPTS.md` never existed (29 commits, final tree identical); backup of every pre-rewrite ref:
  `.harness/pre-rewrite-backup.bundle` (local, gitignored).
- New public repo `husnainali588/ts-api-harness`: `main` only, no tags. Verified on a fresh clone: `git log --all` on
  the three paths prints nothing; full-history secret scan clean.
- Scripted greenfield run `20261005111042-d31bf6` shipped to it as PR #1 (GREEN: tests PASS 44, continuity 2/2, tsc
  0 errors, standards 100%, problem-probe 25/25).

**UNPROVEN / BLOCKED**
- No live run finished green on either driver; Claude greenfield failed three times (Haiku 4.5, cost caps).
- Not run (budget): OpenAI greenfield, brownfield live run, live token bench; the Sonnet 5.5 default is unverified;
  the openai driver ran only via the gateway (native covered by recorded fixtures).
- Token target >90% not met offline; core is 3,361 lines (target < 1,500); one approved core change after the freeze.

**Open lines in docs/QUESTIONS.md**
- Confirm `.env.example` has empty values (I could not read it).
- Token target: accept the lower number or spend effort elsewhere.
- (Resolved: BUILD_PROMPTS restore, progress.md wipe, Phase 6 key block.)
- The submission tag was not created (left to you). `api-harness/` (empty, untracked) left untouched.
