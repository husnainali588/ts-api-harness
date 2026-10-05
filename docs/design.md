# Design note — ts-api-harness

A harness, not an agent: it governs TypeScript REST API work through a driver-agnostic loop, hooks that block,
record or pass every tool call, context fetched just in time, and an end decided only by deterministic gates.
Every number here is copied from a file the harness wrote; file paths are given next to each.

## 1. Architecture

```
task file ──► core/task.ts (tolerant loader) ──► git worktree per run (.harness/worktrees/<id>, own branch)
                                                  greenfield: scaffold templates/api   brownfield: green baseline +
                                                                                       contract/findings snapshots
loop (core/loop.ts), one tool call at a time, fresh state each call:
  driver.turn(system ≈220 tokens, brief + state card, compacted history, neutral tool specs)
    └─► for each tool call:  pre-hooks ──block?──► reason + fix back to the model (exit 2)
                              │ pass (0) / record (1)
                              ▼
                              tool.run ──► summary to the model, raw output to runs/<id>/raw/
                              ▼
                              post-hooks (record write hashes, regenerate the route index)
    finish ──► G3 finish gate (core/finish.ts) ──green──► done ──--ship──► G4 (core/ship.ts) ──► branch, commit, push, PR
                              └── not green ──► failing lines go back as the tool result; loop continues
budgets: max turns, consecutive blocks, per-run token cap and total spend ledger (stop = UNPROVEN, evidence written)
```

**The four gates** (each with bypass tests under `test/gates/`):
- **G1 path & scope** — `path-guard`, `scope-guard`: reads and writes stay inside the API root; no `..`, absolute
  paths, symlinks out, `.env`, `.git`, `.harness`, `node_modules`; config (`package.json`, `tsconfig*`, test/lint config),
  the generated route index and (greenfield) the template infrastructure are read-only; brownfield writes only inside
  an accepted `propose_scope`.
- **G2 observed red** — `observed-red`: a `src/` file is written only after a mapped test (an importing test or
  `test/<same path>.test.ts`, resolved with ts-morph) was seen failing by `run_tests`; observations come only from the
  harness's vitest run. `red-test-lock` freezes a red test once its source has been written.
- **G3 finish** — full suite green; every test ever seen red still exists, is not skipped and passes; strict `tsc`;
  `harness check` at 100% with nothing UNPROVEN; brownfield adds the ratchet (no new findings, touched files clean) and
  the contract gate (no removed route/field/status, narrowed type, new required request field, removed enum value).
- **G4 ship** — green, nothing unproven, not a baseline run, not a protected branch, staged diff free of key formats
  and env secret values; stages only the API and the run's evidence; never `--force`/`--no-verify`.

**Deterministic vs model-decided.** The model decides the task breakdown, what to read, the tests and the code. The
harness decides whether each call is allowed, whether tests are red or green (its own runner), whether the standards
pass, whether the run is done, and whether anything ships. Git, npm, tsc, vitest and the checks run as `execFile`
subprocesses with argument arrays and a secret-free environment; the model has no shell.

## 2. Driver abstraction

`core/driver.ts` is the only contract: neutral `Message` (user / assistant with tool calls / tool results),
`ToolSpec` (name, description, plain JSON Schema from `z.toJSONSchema`), `TurnRequest`, and a `TurnResponse` with
`usage { inputTokens, outputTokens, source }`, the `transport` and the model id that actually served the turn.
Drivers (`drivers/claude`: Messages wire format; `drivers/openai`: Chat Completions; `drivers/scripted`: free,
deterministic, replays recorded transcripts) own message translation, the vendor tool-schema shape, parallel-result
batching, retries with backoff (429/5xx), model ids from env, and usage normalisation (input = full context processed,
cached included). Each picks its transport from env: native key first, then the OpenRouter gateway.

What we refused to let leak: provider and gateway names, vendor tool schemas (`input_schema`, `tool_use`,
`"type": "function"` …), prompt formats and model ids stay under `drivers/`; `test/no-provider-leak.test.ts` greps
`core/`, `plugins/`, `tasks/`, `templates/`, `examples/` and fails the suite. Prompt caching is never counted as a
footprint reduction. Both runs of the same task share one fingerprint (sha256 of the task file, `plugins/hooks/**`,
`plugins/rules/**`) in `runs/<id>/summary.json`.

## 3. Token budget

**Baseline** (exact definition): same task, same driver, same tools; the system prompt front-loads every text file
under the task's API root (no `node_modules`, no lockfiles), the task file and every context plugin's `frontLoad()`
(standards docs, exported helpers, all schemas), refreshed each turn; tool results raw; no compaction.
**Actual:** ≈220-token system prompt; brief + state card first; tool summaries (raw to disk); last 6 exchanges
verbatim, older tool results become one-line stubs and older large tool-call inputs are dropped (`_elided` note);
long files read without a range return an outline; unchanged re-reads return "unchanged since turn N".

Measured so far — no live baseline was run (budget), so **no evidence-grade reduction exists**:
- Offline estimate (`tokens/20261005105034-a7da99.json`, scripted driver, chars/4, `evidence: false`): baseline
  103,114 input tokens over 8 turns (mean 12,889), actual 44,485 over 14 turns (mean 3,178); reduction over the aligned
  turns 1–8: **80.6% mean per turn**, 80.6% total, 72.6% peak — **target >90% not met**.
- Live actual-mode numbers (`tokens/live-runs.json`, provider usage): Claude Haiku 4.5 greenfield runs averaged 5,464,
  6,664 and 6,737 input tokens per turn (peaks 8,684 / 10,724 / 9,553) over 27–30 turns; smoke tests 2,947 (claude) and
  2,965 (openai) per turn over 3 turns.
- What earns the reduction: the ~9–12k-token front-load is never sent; compacted history keeps actual turns flat while a
  baseline grows. What eats it: ≈1.2k tokens per turn that both sides pay (tool definitions, prompt, brief), and in the
  first turns both histories hold the same small tool results. The live transcripts led to two fixes (outlines for long
  files; dropping old inputs without placeholders).

## 4. Extension points

**Core directory: `core/` — must stay untouched.** A tool, rule (standards check, linter rule, ORM validator), hook,
context fetcher or driver is one folder with an `index.ts` that default-exports `defineTool/defineRule/defineHook/
defineContext/defineDriver` from `core/sdk.ts`; `core/registry.ts` discovers `plugins/{tools,hooks,rules,context}/*`
and `drivers/*` at startup (`_` folders ignored), validates each definition with Zod and fails loudly with the path.
Optional `plugins/registry.json` (`disabled`, `order`, `extraPaths`) is the "registry entry" alternative to copying.
A new rule immediately joins `harness check` with its own per-file pass/FAIL lines (`file:line:col`) and summary line,
and becomes part of the finish gate. Proof: `scripts/extension-demo.sh` drops in a tool (`openapi_diff`), an ORM
validator (`orm-explicit-columns`) and a linter rule (`no-console-in-handlers`); `git diff --stat` shows only
`plugins/<kind>/<name>/index.ts` each time, nothing under `core/` (`test/extensibility.test.ts` repeats it in a temp
copy). Guide: `docs/extending.md`.

## 5. Honesty boundary

**What the checks prove** (offline, every commit): 191 tests with the scripted driver — every G1–G4 bypass attempt in
the spec and the 15 red-team attempts (`docs/redteam.md`) are blocked; the reference API, the sample API and the bare
template score 100%; recorded-fixture tests cover both drivers on both transports (native and gateway).

**Live evidence — stated plainly:**
- Both drivers' live smoke tests passed (3 turns each, valid tool calls; `runs/20261005093629-ad605f` claude,
  `runs/20261005093703-f0f8d8` openai), both via the OpenRouter gateway. The native transports are covered by
  recorded-fixture tests only; the openai driver was deliberately left on the gateway.
- **The Claude greenfield run failed three times** (Claude Haiku 4.5, each stopped by its cost cap, never shipped):
  `20261005094610-7b015f` (147,536 input tokens) — the model wrote history placeholders as file content and imported
  an uninstalled `uuid`; `20261005100426-810aa6` (199,928) — it emitted a placeholder as the first version of a file it
  had never written, then stalled reading files; `20261005101157-abd57c` (195,373) — no placeholders after the fix, but
  `uuid` again and an invented helper (`PaginatedList`). Fixes: `placeholder-guard`, compaction that keeps the window
  verbatim and drops old inputs without placeholder text (approved core change), `import-guard`, `get_standard exports`
  (the real helper names). Offline replays show the guards firing at those exact writes (`runs/20261005104317-6c530e`,
  `…104330-4a29b2`, `…104335-bb9486`).
- **No live run finished green on either driver.** The OpenAI greenfield run, the brownfield run and the live token
  report (bench) **were not run** because the budget was stopped. A free-model rehearsal stopped on a 429 at turn 6.
- **The default models are unverified**: the claude default is now Claude Sonnet 5.5 (never run live); the openai
  default GPT-5.4 Mini passed only its 3-turn smoke test.
- The shipped PR (#2) and the brownfield run are **scripted-driver** evidence: real gates, scripted code
  (`runs/20261005104836-119e72`: tests PASS 44, continuity 2/2, tsc 0 errors, standards 100% with 9 rules incl.
  problem-probe 25/25; `runs/20261005104956-3ed10f`: ratchet pass, contract pass with additive `notes` changes).

**What the checks skip or cannot see** (reported as UNPROVEN, never green): anything a rule could not run (missing
dependencies, unbootable app, gh unavailable). **What a human must still verify:** business-logic correctness beyond
the tests; test quality beyond red→green with at least one assertion; security; performance; persistence semantics
(the template store is in memory); test code itself runs with filesystem access during `run_tests`.

## 6. Our own addition: problem-probe

A required rule that boots the API in a fresh subprocess (127.0.0.1, ephemeral port), reads the route table from
`createApp().routeTable` (or, for hand-written Express, from static analysis with the parsed schemas imported by
name) and sends schema-generated bad requests per route: malformed JSON, empty body, each required field missing,
each field with the wrong type, malformed and unknown ids, unknown route, wrong method, `limit=0`, `limit=10000`,
garbage cursor, duplicate unique field, Idempotency-Key replay and reuse. Every non-2xx must be
`application/problem+json`, parse as a Problem, have `status` = HTTP status and `instance` = request path, leak no
stack trace, and be in the family's allowed set. It catches what static checks cannot: framework defaults such as
HTML 404s for unknown routes, body-parser errors on malformed JSON, `res.json()` silently setting
`application/json`, and a missing `instance` (`test/probe.test.ts` proves each). Scripted greenfield output:
25/25 probes (`reports/check-20261005105215-10cef9/standards.txt`).

Core is 3,361 lines (target was < 1,500): the public plugin types, the brownfield contract snapshot and the static
route analysis shared with the rules live there. Core changed once after the freeze, with approval (decisions.md).
