# ts-api-harness

An agent harness that governs TypeScript REST API work: a loop that calls a model through a driver, runs every
tool call through hooks that can block, record or pass, fetches context just in time, and ends only when
deterministic checks say the work is done. Built for the sf-harness engineering assignment
(`docs/assignment/brief.pdf`).

**Status: in progress.** Setup, grader commands, design note and evidence links are added as the build lands.

## Task files and sample API

No task file or sample API was provided with the assignment, only the brief. We wrote them ourselves:

- `tasks/users.yaml` — greenfield: a new `users` API (create, get, cursor-paginated list, partial update, delete;
  duplicate email → 409).
- `fixtures/sample-api/` — a small existing orders API (Express 5, Zod 4, strict TypeScript, passing tests) that
  already follows the brief's API standards.
- `tasks/orders-add-field.yaml` — brownfield: add an optional `notes` field to orders without breaking the contract.

The task format uses the brief's own keys — `resource`, `fields`, `behaviours` — plus `api:` for brownfield
tasks. **A grader can drop their own task file into `tasks/` and run it:**

```
npx harness run --task tasks/<your-task>.yaml --driver claude
npx harness run --task tasks/<your-task>.yaml --driver openai
```

The loader is built to tolerate small format differences (see `docs/decisions.md`).
