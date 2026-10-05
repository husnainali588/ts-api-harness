# CLAUDE.md — sf-harness assignment: TypeScript REST API harness

Claude Code: read this whole file at the start of every session. The brief is `docs/assignment/brief.pdf`.
If this file and the brief disagree, the brief wins — stop and tell me. Build phases are in
`docs/BUILD_PROMPTS.md`; do exactly one phase at a time.

---

## 0. What we are building

An agent **harness**, not an agent. A loop that calls a model through a **driver**, wraps every tool call in
**hooks** that can block, record or pass, fetches context **just in time**, and ends only when **deterministic
checks** (never the model) say the work is done. It governs TypeScript REST API work:

- **Greenfield:** task file → new API (routes, Zod schemas, handlers, tests).
- **Brownfield:** a scoped change to an existing API without breaking contracts or drifting from standards.

The graders score the harness. The generated API is only evidence that the harness works.

| Dimension (25% each, scored 0/50/100) | What the grader runs | What must be true |
|---|---|---|
| Model agnosticism | `harness run --task T --driver claude`, then `--driver openai` | Zero diff in task file, hooks and checks between runs. Both runs end 100% green. No provider names, prompt formats or tool-schema shapes outside `drivers/`. |
| Token efficiency | Reads `tokens/<runId>.json` | >90% reduction in input tokens per turn vs baseline (same task, same driver, JIT fetchers + compaction disabled), measured from provider usage fields. |
| API standards | `harness check --api <path>`, then their own reference checks | 100% on both. One fail anywhere = 0 for the dimension. |
| Extensibility | Adds a tool, a custom ORM validator and a linter rule, live | After each, `git diff --stat` shows only the new plugin's files (+ optional registry entry). Nothing under `core/`. |

---

## 1. Hard rules

Never break these. Never weaken a gate or a check to make a test pass — stop and ask instead.

1. **No provider leaks.** Provider and gateway words (`anthropic`, `openai`, `openrouter`, `claude`, `gpt`,
   `sonnet`, `opus`, `haiku`)
   and vendor wire shapes (`input_schema`, `tool_use`, `tool_result`, `function_call`, `"type": "function"`)
   appear only under `drivers/`. Never in `core/`, `plugins/`, `tasks/`, `templates/`.
   `test/no-provider-leak.test.ts` greps for them and fails the suite.
2. **Extensions never touch core.** Adding a tool, rule, ORM validator, hook, context fetcher or driver = adding
   a folder under `plugins/` or `drivers/`, nothing else. Core may evolve during Phases 1–9. From Phase 10 it is
   frozen and `test/extensibility.test.ts` proves new plugins need no core edit.
3. **The model has no shell and no git.** It acts only through tools in `plugins/tools/`. Git, npm, tsc,
   vitest and checks run as harness subprocesses via `execFile` with argument arrays — never `shell: true`,
   never string-built commands.
4. **Nothing is green on the model's word.** Every check result is `pass | fail | unproven | n/a`.
   `unproven` (could not run) never counts as pass. `n/a` (zero applicable sites, e.g. an ORM rule on code with
   no ORM) is printed and excluded from the verdict. Only the finish gate ends a run.
5. **No secrets in the repo.** Keys come only from env. `.env` is gitignored; `.env.example` has empty values.
   You (Claude Code) never open, read, print or `cat` `.env`, and never ask me to paste a key into the chat.
   To check which keys are set, use `harness doctor`, which prints variable names only.
   Everything written to `runs/`, `reports/`, `tokens/` passes through `core/redact.ts`. The ship step scans the
   staged diff and refuses on a hit.
6. **Measured, not claimed.** Every number in README or `docs/design.md` is copied from a file the harness
   wrote (`tokens/`, `reports/`, `runs/`). Never type a number by hand.
7. **The model cannot edit its judges.** The path guard blocks model writes to `.harness/`, `core/`, `drivers/`,
   `plugins/`, `tasks/`, `templates/`, `.git/`, test-runner config, `tsconfig*.json`, eslint config and
   `package.json`. Dependencies are added only via the `add_dependency` tool (allowlist).
8. **Small and mechanical.** Four unbypassable gates beat forty suggestions.
   Cheapest mechanism wins: check > hook > rule > command > prompt line.
9. **The harness obeys what it enforces:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
   no `any`, no non-null `!`, no `@ts-ignore`.
10. **Spend is capped by code — the key is a company key.** Never call a live provider unless I explicitly ask
    for a live run in this session. All development and tests use the scripted/replay driver. Every live run has
    a hard cap on cumulative input tokens (`--max-run-tokens`, default from `HARNESS_MAX_RUN_TOKENS`, e.g.
    400000) and a turn cap; when either is hit the run stops, is marked `unproven` ("stopped by cost cap"), and
    still writes its evidence. Print the run's token totals at the end of every live run.

---

## 2. Stack

- Node ≥ 22, TypeScript 5.x, ESM. Run TypeScript directly with `tsx` (no build step), so a dropped-in plugin
  file loads on the next run without compiling.
- Zod 4 everywhere. Tool input schemas are Zod; core converts them with `z.toJSONSchema()`; each driver
  translates that neutral JSON Schema into its vendor's shape.
- `ts-morph` (with the type checker) for AST rules; `typescript` for tsc; `vitest` with the JSON reporter as the
  governed test runner; `fast-glob`, `yaml`, `pluralize`.
- Provider SDKs are imported only inside `drivers/`.
- `gh` CLI for opening pull requests.
- Generated APIs use the **same HTTP framework as the provided sample API** (read `fixtures/sample-api` first),
  so one set of rule logic covers greenfield and brownfield. If free to choose: Express 5.

---

## 3. Layout

```
core/                       ENGINE. Named in README. Extensions never touch it.
  cli.ts                    harness run | bench | check | ship | plugins | doctor
  loop.ts                   the agent loop
  driver.ts                 Driver interface + neutral message/tool types
  hooks.ts                  pre/post pipeline, HookOutcome, exit codes
  registry.ts               auto-discovers plugins/ and drivers/
  sdk.ts                    public plugin API: defineTool/Rule/Hook/Context/Driver
  context.ts                state card, compaction, baseline front-loading
  tokens.ts                 token ledger + tokens/<runId>.json
  checks.ts                 rule runner, line printer, verdict
  state.ts                  observation ledger, file hashes, source↔test map
  workspace.ts              git worktree per run, safe path resolution
  ship.ts                   branch/commit/push/PR, secret scan
  task.ts                   task loader + Zod schema of the task file
  redact.ts
drivers/                    the ONLY place provider names may appear
  claude/index.ts
  openai/index.ts
  scripted/index.ts         deterministic, free driver: scripted tool calls, or replay of a recorded live
                            session (runs/<id>/transcript) for debugging without spend. Its token numbers
                            are marked "estimate"/"replay" and can never be used as evidence.
plugins/                    auto-discovered; folders starting with "_" are ignored
  tools/<name>/index.ts
  hooks/<name>/index.ts
  rules/<name>/index.ts     standards checks, linter rules, ORM validators
  context/<name>/index.ts   JIT fetchers (standards docs, schemas, task sections)
  registry.json             optional: disabled[], order{}, extraPaths[]
templates/api/              deterministic scaffold for greenfield (harness-written, already 100% green)
tasks/                      provider-neutral task files (the provided one, never edited)
fixtures/sample-api/        the provided brownfield repo
examples/extensions/        three grader-style additions + fixtures, used by the demo script
scripts/grade.sh            simulates the graders end to end
scripts/extension-demo.sh
test/                       the harness's own tests (gates, registry, leak, extensibility)
runs/<runId>/               events.jsonl, driver.log, raw/, summary.json, pr.md   (committed evidence)
tokens/<runId>.json
reports/<runId>/standards.txt + standards.json
.harness/                   runtime state + worktrees (gitignored)
docs/design.md              the design note
docs/extending.md           how to add a tool / rule / validator / hook / driver
```

---

## 4. CLI (graders type these — keep them exact)

- `npm run setup` — one command: install, check Node version, copy `.env.example` → `.env` if missing, run
  self-tests with the scripted driver.
- `npx harness run --task <file> --driver <id> [--baseline] [--ship] [--max-turns N]`
- `npx harness bench --task <file> --driver <id>` — baseline run, then actual run; writes `tokens/<runId>.json`.
- `npx harness check --api <path>` — standards check; exit 0 only at 100%.
- `npx harness ship --run <runId>`
- `npx harness plugins` — lists discovered drivers, tools, hooks, rules, context fetchers with their source path.

`package.json` → `"bin": { "harness": "./bin/harness.mjs" }`, which runs `core/cli.ts` through tsx.
`--driver <id>` is resolved against ids exported from `drivers/*/index.ts`. Core never contains a provider name.

---

## 5. Core design

### 5.1 Driver interface (`core/driver.ts`)

```ts
export interface ToolSpec { name: string; description: string; inputSchema: JsonSchema } // name: ^[a-z0-9_]{1,64}$
export interface ToolCall { id: string; name: string; input: unknown }
export interface ToolResult { callId: string; content: string; isError: boolean }
export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };
export interface TurnRequest { system: string; messages: Message[]; tools: ToolSpec[]; maxOutputTokens: number }
export interface Usage { inputTokens: number; outputTokens: number; source: 'provider' | 'estimate' }
export interface TurnResponse { text: string; toolCalls: ToolCall[]; stop: 'tool_calls' | 'end' | 'length'; usage: Usage }
export interface Driver { readonly id: string; turn(req: TurnRequest): Promise<TurnResponse> }
```

Adapters own everything vendor-specific: role/message translation, tool-schema shape, batching parallel tool
results the way each API wants, retries with backoff, model id (from env read inside the driver), and usage
normalisation. **Input tokens = the full context processed that turn**, including cached tokens (sum cached +
uncached on providers that split them). Prompt caching must never masquerade as a footprint reduction.
Don't use a vendor's "strict" function mode unless the adapter converts optional fields correctly.

**Transports (native or OpenRouter).** Our live runs use one `OPENROUTER_API_KEY`; graders may bring native
keys. Each driver picks its transport from env, inside the driver, in this order: native key
(`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) → `OPENROUTER_API_KEY` → throw a clear "no key" error.
- `drivers/claude` keeps the **Anthropic Messages wire format on both transports**: same SDK, only the base URL
  and auth change (OpenRouter exposes a Messages-compatible endpoint with Bearer auth). This keeps the two drivers
  on genuinely different wire formats, and the native path is a two-line difference from the one we test live.
- `drivers/openai` uses Chat Completions on both transports: same SDK, OpenRouter base URL + key.
- Model ids come from env inside each driver (`HARNESS_CLAUDE_MODEL`, `HARNESS_OPENAI_MODEL`), with the
  cheapest suitable models as defaults:
  | Driver | via OpenRouter | native |
  |---|---|---|
  | claude | `anthropic/claude-haiku-4.5` | `claude-haiku-4-5-20251001` |
  | openai | `openai/gpt-5.4-mini` | `gpt-5.4-mini` |
  Confirm these ids still exist on openrouter.ai/models before coding; if one is gone, pick the cheapest
  tool-capable model of the same family and record it in `docs/decisions.md`.
- Keep extended thinking / reasoning off or at the lowest setting by default — it costs output tokens. Check
  which parameters each default model accepts before sending any; send nothing a model doesn't support.
- Verify base URLs, auth headers and usage fields against OpenRouter's current docs before writing the code.
- Both transports get recorded-fixture unit tests. Each turn's result carries `transport: 'native' | 'gateway'`
  and the model id that actually served it (from the response), so evidence files can say what really ran.
- Never set `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN` anywhere: Claude Code reads those too. Use our own
  variable names (`OPENROUTER_API_KEY`, `HARNESS_*`).

### 5.2 Loop (`core/loop.ts`)

```
load task → create worktree
  greenfield: scaffold templates/api deterministically
  brownfield: baseline snapshot (tests, findings, contract, map) — see §8
messages = [user: compact task brief + state card]
until done or budget exhausted:
  res = driver.turn({ system, messages: context.render(), tools })
  ledger.record(turn, res.usage)
  for each call in res.toolCalls, ONE AT A TIME, re-reading state before each:
    pre  = hooks.pre(call)        block → tool result = reason + fix, isError = true
    out  = tool.run(call)         tools return { summary, raw? }; raw → runs/<id>/raw/<n>.txt
    post = hooks.post(call, out)  record observations, update state card
  if the model called finish: run the finish gate (§6 G3)
    green → done
    not green → failing lines go back as the tool result; loop continues
  if no tool calls and no finish: one nudge ("act through tools; call finish when done"), counts toward budget
budget exhausted, or N consecutive blocks → stop with FAIL/UNPROVEN, never ship
write summary.json, standards report, token ledger; if --ship and all gates green → ship (§5.8)
```

The model decides: task breakdown, what to read, test content, code. The harness decides: whether a write is
allowed, whether tests are red or green, whether standards pass, whether the run is done, whether anything ships.

System prompt: under ~800 tokens, provider-neutral. Says only: you act only through tools; hooks enforce rules
and a blocked call returns the reason and the fix; the loop is test → run_tests (see red) → source →
run_tests (see green) → run_checks → finish; fetch only what the next step needs.

### 5.3 Hooks (`core/hooks.ts`)

```ts
type HookOutcome =
  | { decision: 'pass' }
  | { decision: 'record'; note: string }
  | { decision: 'block'; reason: string; fix: string };
// every decision is logged to runs/<id>/events.jsonl with an exit status: pass=0, record=1, block=2
defineHook({ id, phase: 'pre' | 'post', order, matches(call), run(call, ctx) })
```

Block feedback always states the next action, e.g.
`BLOCKED observed-red: src/routes/users.ts has no mapped test seen failing. Write test/routes/users.test.ts, call run_tests, see it fail, then retry.`

### 5.4 Registry (`core/registry.ts`, `core/sdk.ts`)

Discover `plugins/{tools,hooks,rules,context}/*/index.ts` and `drivers/*/index.ts` at startup (skip
`_`-prefixed folders). Each default-exports the result of a `define*` call from `core/sdk.ts`. Validate every
definition with Zod at load; a broken plugin fails loudly with its path. `plugins/registry.json` is optional
(`disabled`, `order`, `extraPaths`). Ship a `_template` folder for each kind.

Plugin shapes:

```ts
// tool — returns a compact summary; raw output is optional and goes to disk
export default defineTool({
  name: 'openapi_diff',
  description: 'Compare two OpenAPI files; list breaking changes.',
  input: z.object({ before: z.string(), after: z.string() }),
  async run(input, ctx) { return { summary: '2 breaking: …', raw: fullText }; },
});

// rule — standards check, linter rule or ORM validator; one line per file in the report
export default defineRule({
  id: 'orm-explicit-columns',
  description: 'Prisma/Drizzle queries on users select explicit columns',
  unit: 'queries',              // printed in the summary: "12/12 queries"
  files: ['src/**/*.ts'],       // globs relative to the API root
  required: true,               // counts toward the verdict
  check(file, ctx) {            // ts-morph SourceFile; ctx: project, checker, apiRoot, exec
    return { checked: 3, failures: [{ line: 41, col: 7, message: 'findMany on users without select', fix: 'add select' }] };
  },
  // or: checkProject(ctx) → per-file results (used by tsc-strict, problem-probe)
});

// context fetcher — what JIT fetches on demand, and what baseline mode front-loads
export default defineContext({ name: 'standards', fetch(key, ctx), frontLoad(ctx) });
```

### 5.5 Context: JIT + compaction (`core/context.ts`)

**Actual mode:** tiny system prompt; first user message = task brief + state card. Everything else is fetched
by tools: `list_files` (paths only, capped), `read_file` (line ranges, capped; re-reading an unchanged file
returns `unchanged since turn N`), `search_code` (file:line hits, capped), `get_standard(ruleId)`,
`get_schema(name)`. Tool results are `summary`; raw goes to disk and is referenced by path.
History compaction: keep the last 6 exchanges verbatim; older tool results become one-line stubs
(`[read_file src/x.ts:1-80 — dropped, re-read if needed]`); the state card (task, phase, files written,
last test summary, last check summary, open blocks, red tests awaiting green) is re-rendered every turn.

**Baseline mode (`--baseline`)** — same task, same driver, same tools, but: (a) the system prompt front-loads
everything the fetchers could have returned (every text file in the workspace except `node_modules`, `.git`,
lockfiles, `runs/`; plus every context plugin's `frontLoad()`), (b) tool results are `raw`, (c) no history
compaction. The baseline/actual difference lives entirely in core — tools and plugins don't know which mode
is on. Write this exact definition in the design note.

### 5.6 Token ledger (`core/tokens.ts`)

Every turn records `{ turn, inputTokens, outputTokens, source }` from the driver's normalised usage.
`harness bench` writes `tokens/<runId>.json`:

```json
{
  "task": "tasks/<file>", "taskSha256": "…", "driver": "<id>",
  "transport": "native | gateway", "servedBy": ["<model ids reported by the responses>"],
  "measuredFrom": "provider usage: input tokens incl. cached",
  "baseline": { "runId": "…", "completed": true, "turns": [{ "turn": 1, "inputTokens": 0, "outputTokens": 0 }],
                "totalInputTokens": 0, "meanInputTokensPerTurn": 0, "peakInputTokens": 0 },
  "actual":   { "runId": "…", "completed": true, "turns": [], "totalInputTokens": 0, "meanInputTokensPerTurn": 0, "peakInputTokens": 0 },
  "perTurn":  [{ "turn": 1, "baseline": 0, "actual": 0, "reductionPct": 0 }],
  "reductionPct": { "meanPerTurn": 0, "total": 0, "peak": 0 },
  "targetPct": 90, "met": true,
  "mechanisms": { "jitFetches": 0, "bytesNotFrontLoaded": 0, "compactedToolReturns": 0,
                  "rawBytesDivertedToDisk": 0, "historyStubs": 0, "unchangedRereadsSkipped": 0 }
}
```

If the baseline overflows or fails, keep the turns it completed and set `"completed": false`. Never pad the
baseline with anything the fetchers would not have returned.

**Capped baseline (cost control).** `harness bench --baseline-turns N` stops the baseline after N turns
(`"completed": false`, `"stoppedBy": "baseline turn cap (cost)"`) while the actual run goes to completion.
`perTurn` and `reductionPct.meanPerTurn` are computed over the aligned turns 1..N only, and the report says so
in a `"note"` field. Capping early is usually conservative (raw baseline history keeps growing while compacted
turns stay flat, so later turns tend to show a bigger reduction), but never claim a full-run number from a
capped baseline. `bench` refuses to use the scripted/replay driver for evidence.
`--actual-run <runId>` reuses an existing live run's ledger as the actual side (must be the same task sha256
and the same driver id — verify both and refuse otherwise), so bench only pays for the baseline turns.

### 5.7 Checks (`core/checks.ts`) and output format

`harness check --api <path>` loads the API at `<path>`; if `node_modules` is missing it runs
`npm ci --ignore-scripts` as a subprocess (failure → affected rules `unproven`). It runs every rule plugin,
prints one line per rule per file, then a summary, and writes `reports/<runId>/standards.txt` and `.json`.

```
zod-boundary      pass      src/routes/users.ts            5/5 handlers
problem-json      FAIL      src/routes/users.ts:57:9       ad-hoc { error } body on 404 → use problem()
tsc-strict        pass      tsconfig.json                  0 errors
orm-explicit-cols n/a       (no ORM queries)               0 queries
────────────────────────────────────────────────────────────
zod-boundary      pass      12/12 handlers
problem-json      pass       9/9 error paths
tsc-strict        pass       0 errors
no-unsafe-ts      pass       0 sites
rest-conventions  pass       6/6 routes
tests-mapped      pass       8/8 files
problem-probe     pass      41/41 probes
verdict           100%      → all rules pass
```

Verdict = passing required rules ÷ required rules that are not `n/a`. `unproven` counts as not passing.
Exit 0 only at 100%.

### 5.8 Workspace and ship (`core/workspace.ts`, `core/ship.ts`)

Each run works in its own git worktree under `.harness/worktrees/<runId>` on branch
`harness/<task>-<driverId>-<shortRunId>`, so the user's working tree is never touched. All file tools resolve
paths with `realpath` against the worktree root and reject anything outside it.

Ship (only the harness ships; see G4): stage only the run's output/scope plus its evidence files (never
`git add -A`), commit with a message that includes the gate summary, `git push -u origin <branch>`, open the PR
with `gh pr create --body-file runs/<id>/pr.md` (body = standards summary + token summary + honesty section),
record the PR URL in `summary.json`. Never `--force`, never `--no-verify`. If `gh` is missing or not
authenticated, ship is `unproven` with the reason — no clever fallbacks.

### 5.9 Evidence

Every run writes `runs/<runId>/summary.json` with: task path + sha256, a fingerprint (sha256) of
`tasks/<file>`, `plugins/hooks/**`, `plugins/rules/**` (proves zero diff between drivers), driver id,
transport, serving model ids, gate results, verdict, token totals, PR URL, and an honesty block (`proven`,
`unproven` with reasons, `outOfReach`). If live runs only used the gateway transport, the honesty block says the
native transport is covered by recorded-fixture tests only.

---

## 6. Gates (the unbypassable ones)

Each gate has tests in `test/gates/*.test.ts` that use the scripted driver to attempt the bypass and assert it
is blocked.

**G1 Path & scope guard (pre-hook on every file tool).** Rejects paths outside the worktree, `..`, symlinks
leading out, every protected path in §1.7, and (brownfield) anything outside the accepted scope.

**G2 Observed red (pre-hook on `write_file`/`edit_file` to a source file).** Source = any non-test `.ts` under
the API's `src/`. Mapped tests = tests that import the source, resolved from import specifiers with ts-morph
(works even before the source exists), plus the `src/x/y.ts` ↔ `test/x/y.test.ts` convention. The write is
allowed only if a mapped test file has at least one test case recorded as **failing** in
`.harness/runs/<id>/observations.json` — written only by the `run_tests` tool from vitest's JSON output, never
by the model. The red test case ids (file + full name) are recorded for G3. Calls are processed one at a time
with fresh state, so a test write and a source write in the same turn cannot both pass.

**G3 Finish gate (when the model calls `finish`).** All must hold:
1. full test suite green via the harness runner;
2. **red→green continuity:** every test case recorded red under G2 still exists, is not skipped, and now passes
   (the model can't unlock with a throwaway failing test and then delete or weaken it);
3. `tsc --noEmit` clean under the strict config;
4. `harness check --api` at 100%, zero `unproven` among required rules (includes the problem probe);
5. brownfield only: ratchet + contract gate (§8).
Failing lines go back to the model as the `finish` tool result.

**G4 Ship gate.** Preconditions: last run's G3 green, not a baseline run, secret scan clean (regexes for common
key formats including `sk-or-`, `sk-ant-`, `sk-proj-`, `ghp_`, `github_pat_`, plus a literal search for the
current values of every env var ending in `_KEY` or `_TOKEN`), branch
not protected (`main`, `master`, `develop`, `trunk`, `release/*`, `prod*`, and the remote default branch).
Anything else → refuse with the reason.

Bypass attempts the tests must cover: source before any test; test written but never run; test run green
instead of red; red test deleted, renamed or `.skip`ped later; test + source in one turn; writes to vitest
config, tsconfig, `.harness/`, `package.json`; `.only`/`.skip`/`.todo`; `@ts-expect-error`/`eslint-disable`;
path traversal and symlinks; brownfield write outside scope; `finish` with failing checks; ship with any
`unproven`; ship to `main`.

---

## 7. API standards rules (`plugins/rules/*`)

| Rule id | Unit | Fails when |
|---|---|---|
| `zod-boundary` | handlers | A route lacks a params schema (path has params), query schema (GET/list), body schema (POST/PUT/PATCH), or a response schema for any status it returns; a handler reads raw `req.body`/`req.query`/`req.params` instead of parsed values; a hand-written `interface`/object `type` duplicates a schema instead of `z.infer`; `z.any()` is used. |
| `problem-json` | error paths | Any non-2xx response not built with `problem()`; any of `type`, `title`, `status`, `detail`, `instance` missing; ad-hoc `{ error }`/`{ message }` bodies; no catch-all 404, malformed-body handler or fallback error handler registered. |
| `tsc-strict` | errors | `tsc --noEmit` fails, OR the API's tsconfig lacks `strict: true` or `noUncheckedIndexedAccess: true` (a missing flag is a fail, not a pass). |
| `no-unsafe-ts` | sites | Explicit `any`, `as any`, non-null `!`, `@ts-ignore`, `@ts-nocheck`, `@ts-expect-error`, `eslint-disable`, and any expression the type checker types as `any` (e.g. an unparsed `JSON.parse`). |
| `rest-conventions` | routes | Base path not `/v{n}`; a collection segment not plural; a list endpoint without `cursor`+`limit` or with `page`/`offset`; list response not `{ data, nextCursor }`; POST create without idempotency-key support; create ≠ 201 (+ `Location`); delete ≠ 204 or has a body; validation ≠ 422; missing 404/409 where the task declares lookups/unique fields. |
| `tests-mapped` | files | A source file with no mapped test; `.skip`, `.only`, `.todo` anywhere. |
| `problem-probe` | probes | Our own addition — see §9. |

Template decisions to keep consistent across rules, probe and design note:
- Validation failures → **422**. Syntactically malformed JSON → **400** problem+json (decide once, document it).
- `Idempotency-Key` on POST is **optional but honoured** (same key + same body → identical replay; same key +
  different body → 409). Don't make it required, or reference tests that POST without it get a 4xx.
- Problem `type` URIs: `https://api.sf/problems/<slug>`; `instance` = request path (as in the brief's example).
- Express sets `application/json` inside `res.json()` unless Content-Type is already set — set
  `application/problem+json` first. Register a catch-all 404 and convert the body parser's `SyntaxError` to
  problem+json; both default to non-problem responses otherwise.
- No singular "utility" routes (e.g. `/v1/health`) in the API — they trip the plural-nouns rule.

---

## 8. Greenfield template and brownfield flow

**Greenfield — `templates/api/` (written by the harness, not the model).** Deterministic infrastructure so the
model only writes resource code: strict tsconfig; `createApp()` exposing the route table; `defineRoute({
method, path, params, query, body, responses, handler })` which parses every input and validates the response
against `responses[status]` before sending; `problem()` + Problem schema; error handlers (404 catch-all,
malformed JSON, ZodError → 422, NotFound → 404, Conflict → 409, unknown → 500 without stack); cursor codec and
`Page<T>` schema; idempotency middleware with an in-memory store; vitest setup. The template has no routes and
`harness check` on it passes with every rule `pass` or `n/a`; a test proves that.

**Brownfield — on `fixtures/sample-api`.**
1. Install and run its tests. Baseline must be green, otherwise stop: `unproven` ("baseline red").
2. Snapshot `contract.before.json` (route table + JSON Schema of every request/response schema) and
   `findings.before.json` (all rule findings) into `.harness/runs/<id>/`.
3. Build the source↔test map from the import graph.
4. The model must call `propose_scope({ files, reason })` before any write. The harness accepts files reachable
   from the target resource in the import graph (or new files beside them) and rejects others with feedback.
   G1 enforces the accepted scope; widening it means another validated `propose_scope`.
5. G2 applies as in greenfield.
6. Finish adds: **ratchet** — touched files 100% on all rules, and no new findings anywhere vs
   `findings.before`; **contract gate** — no breaking change (removed route/field/status, narrowed type, new
   required request field, removed enum value); additive changes are listed in the PR body; the problem probe
   runs on touched routes.

---

## 9. Our own addition: problem-probe (schema-driven negative probing)

A dynamic rule + gate that sf-harness doesn't have. Static checks can't see framework defaults (HTML 404s for
unknown routes, body-parser errors on malformed JSON) — exactly where reference checks catch people.

- Reads the route table from `createApp()` (fallback: AST route extraction; neither → `unproven`).
- Boots the app in-process on an ephemeral port — no external network.
- Per route, generates requests from the Zod schemas: malformed JSON; empty body; each required field missing;
  each field with the wrong type; malformed and unknown path ids; unknown route under `/v1`; wrong method;
  `limit=0`, `limit=10000`, garbage `cursor`; duplicate unique field; idempotency replay (same key + body →
  identical status and body) and key reuse with a different body.
- Asserts on every non-2xx: media type is `application/problem+json`; body parses with the Problem schema;
  `status` equals the HTTP status; `instance` equals the request path; no stack traces; status is in the
  allowed set for that probe.
- One report line per probe family per route; full transcripts to `runs/<id>/raw/probe/`.
- It is a required rule, so it is part of `harness check --api` and the finish gate.

---

## 10. How you (Claude Code) work in this repo

- One phase at a time from `docs/BUILD_PROMPTS.md`. Show a short plan before writing code in a new phase.
- Write the harness's own tests first, especially gate-bypass tests. Unit tests use the scripted driver and
  never call real provider APIs.
- Before every commit: `npm test`, `npm run typecheck`, the leak test. Commit at the end of each phase with a
  conventional message. Never commit `.env`.
- Keep `core/` small (target < 1,500 lines). If a change to core is tempting after Phase 9, it is an extension
  point problem: stop and ask.
- Record non-obvious decisions in `docs/decisions.md` (one line each) — they feed the design note.
- If a real run fails because the model misbehaves, fix it with the cheapest mechanism: better block feedback
  or a check — not a longer system prompt.
