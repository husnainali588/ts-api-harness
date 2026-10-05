# ts-api-harness

An agent **harness** (not an agent) that governs TypeScript REST API work. A loop calls a model through a **driver**,
runs every tool call through **hooks** that can block, record or pass, fetches context **just in time**, and ends only
when **deterministic checks** — never the model — say the work is done. It builds new APIs from a task file
(greenfield) and makes scoped, contract-safe changes to existing ones (brownfield). Built for the sf-harness
engineering assignment; how it works is in [docs/design.md](docs/design.md).

- **Core directory: `core/` — must stay untouched.** Every extension is a folder under `plugins/` or `drivers/`
  ([docs/extending.md](docs/extending.md)).
- Design note: [docs/design.md](docs/design.md) · decisions: [docs/decisions.md](docs/decisions.md) ·
  red team: [docs/redteam.md](docs/redteam.md) · build log: [docs/progress.md](docs/progress.md)
- **Our own addition: `problem-probe`** — boots the API and probes every route with schema-generated bad requests
  (malformed JSON, missing/wrong fields, bad ids, unknown routes, wrong methods, pagination bounds, duplicates,
  idempotency replay); every error must be a correct `application/problem+json`. It is a required rule, so it is part
  of `harness check` and the finish gate.

## Setup (one command)

```
npm run setup        # Node >= 22; installs, creates .env from .env.example if missing, runs the self-tests
npx harness doctor   # environment check; prints env variable NAMES, never values
```

Keys (in `.env`, never committed): either native keys — `ANTHROPIC_API_KEY` for `--driver claude`,
`OPENAI_API_KEY` for `--driver openai` — or a single `OPENROUTER_API_KEY` for both. Each driver picks native first,
then the gateway. Optional: `HARNESS_CLAUDE_MODEL`, `HARNESS_OPENAI_MODEL` (defaults: Claude Sonnet 5.5 and
GPT-5.4 Mini — **neither verified by a full live run**, see Evidence), `HARNESS_MAX_RUN_TOKENS`, `HARNESS_TOTAL_BUDGET`
(spend caps, enforced in code; a run that hits its cap stops as UNPROVEN and still writes its evidence).

## Grader commands

```
npx harness run   --task tasks/users.yaml --driver claude      # greenfield, writes runs/<id>/
npx harness run   --task tasks/users.yaml --driver openai      # same task, other provider
npx harness check --api generated/users-api [--task tasks/users.yaml]   # exit 0 only at 100%
npx harness bench --task tasks/users.yaml --driver claude [--baseline-turns 8] [--actual-run <runId>]  # tokens/<runId>.json
npx harness run   --task tasks/orders-add-field.yaml --driver claude --ship   # brownfield change + pull request
npx harness ship  --run <runId>
npx harness plugins                                            # every driver/tool/hook/rule/context with its path
bash scripts/grade.sh                                          # offline grader simulation
bash scripts/extension-demo.sh                                 # three additions, no core change
```

Useful flags: `--max-turns N`, `--max-run-tokens N`, `--total-budget N`, `--baseline`, `--script <file>` with
`--driver scripted` (free, deterministic; replays recorded transcripts too).

## Task files and sample API

No task file or sample API was provided with the assignment, only the brief. We wrote them ourselves:

- `tasks/users.yaml` — greenfield: a new `users` API (create, get, cursor-paginated list, partial update, delete;
  duplicate email → 409).
- `fixtures/sample-api/` — a small existing orders API (Express 5, Zod 4, strict TypeScript, passing tests) that
  already follows the brief's API standards.
- `tasks/orders-add-field.yaml` — brownfield: add an optional `notes` field to orders without breaking the contract.

The task format uses the brief's own keys — `resource`, `fields`, `behaviours` — plus `api:` for brownfield
tasks. **A grader can drop their own task file into `tasks/` and run it** with the commands above; the loader
tolerates small format differences (YAML or JSON, `behaviors`, field lists or maps, nested `resource`, extra keys —
see `docs/decisions.md`).

## Evidence

**Pull request opened by the harness:** [PR #1](https://github.com/husnainali588/ts-api-harness/pull/1) — shipped by
the harness's own ship step (G4) after every gate was green, from a run with the scripted driver (see below).

Honest summary (details and numbers in [docs/design.md §5](docs/design.md#5-honesty-boundary)):

- **Offline, proven on every commit:** 191 tests with the free scripted driver — all G1–G4 bypass attempts blocked,
  15 red-team attempts handled ([docs/redteam.md](docs/redteam.md)), the reference/sample/template APIs at 100%,
  both drivers' wire formats on both transports via recorded fixtures. `bash scripts/grade.sh` → 4 PASS, 3 UNPROVEN,
  0 FAIL (the UNPROVEN items are the missing live evidence below).
- **Live:** both drivers' smoke tests passed (`runs/20261005093629-ad605f`, `runs/20261005093703-f0f8d8`). The Claude
  greenfield run **failed three times** (Haiku 4.5, cost cap each time; causes and fixes in the design note:
  `runs/20261005094610-7b015f`, `runs/20261005100426-810aa6`, `runs/20261005101157-abd57c`). **No live run finished
  green on either driver.** The OpenAI greenfield run, the brownfield run and the live token report were **not run**
  (budget). The default models are unverified.
- **Scripted-driver evidence (real gates, scripted code):** greenfield shipped as
  [PR #1](https://github.com/husnainali588/ts-api-harness/pull/1) (titled as scripted) —
  `runs/20261005111042-d31bf6`, standards 100% incl. problem-probe 25/25
  (`reports/20261005111042-d31bf6/standards.txt`; the identical earlier run `runs/20261005104836-119e72` checked with
  `harness check`: `reports/check-20261005105215-10cef9/standards.txt`); brownfield `runs/20261005104956-3ed10f` green with an additive
  contract change only.
- **Tokens:** `tokens/20261005105034-a7da99.json` — offline estimate, `evidence: false`, 80.6% mean per-turn reduction
  (target >90% not met); `tokens/live-runs.json` — real per-turn input of every live run (no live baseline).
- Total live spend: 560,574 input + 27,708 output tokens across five paid runs (≈ $0.70 at OpenRouter list prices).

## Team

- One engineer, building with Claude Code: harness core, drivers, plugins, template, checks, problem-probe, evidence.
