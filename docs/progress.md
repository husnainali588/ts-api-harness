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
