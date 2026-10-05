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
