# Extending the harness

**Core directory: `core/` — must stay untouched.** Every extension is a new folder under `plugins/` (or `drivers/`).
Plugins are discovered at startup from `plugins/{tools,hooks,rules,context}/<name>/index.ts` and
`drivers/<id>/index.ts`; folders starting with `_` are ignored. No build step: the next `npx harness …` loads it.
Check what was found with `npx harness plugins` (it prints each plugin's source path).

The fastest path for any kind: **copy the `_template` folder, rename it (no leading `_`), edit `index.ts`. Done.**

| Kind | Folder | Defined with |
|---|---|---|
| Tool | `plugins/tools/<name>/index.ts` | `defineTool` |
| Rule (standards check, linter rule, ORM validator) | `plugins/rules/<id>/index.ts` | `defineRule` |
| Hook (pre/post tool call) | `plugins/hooks/<id>/index.ts` | `defineHook` |
| Context fetcher | `plugins/context/<name>/index.ts` | `defineContext` |
| Driver | `drivers/<id>/index.ts` | `defineDriver` |

Every `define*` call is validated with Zod when the plugin loads; a broken plugin fails loudly with its path.
Optional `plugins/registry.json`: `{ "disabled": ["id"], "order": { "hook-id": 5 }, "extraPaths": ["some/folder"] }`
(`extraPaths` registers a plugin folder that lives elsewhere — the "registry entry" alternative to copying).

## A tool

```ts
// plugins/tools/openapi_diff/index.ts
import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export default defineTool({
  name: 'openapi_diff',                       // ^[a-z0-9_]{1,64}$
  description: 'Compare two OpenAPI JSON files; list breaking changes.',
  input: z.object({ before: z.string(), after: z.string() }),
  run(input, ctx) {
    const before = ctx.resolvePath(input.before); // API-root-relative; throws outside the workspace
    // …
    return { summary: '2 breaking: …', raw: 'full output (goes to disk, referenced by path)' };
  },
});
```

`summary` is what the model sees; `raw` is stored under `runs/<id>/raw/`. Set `writes: true` if the tool writes files
(write guards then apply) and return `wrote: ['path']`. Complete example: `examples/extensions/openapi_diff/`.

## A rule — standards check, linter rule or ORM validator

```ts
// plugins/rules/orm-explicit-columns/index.ts
import { SyntaxKind } from 'ts-morph';
import { defineRule } from '../../../core/sdk.js';

export default defineRule({
  id: 'orm-explicit-columns',
  description: 'Prisma/Drizzle queries on users select explicit columns',
  unit: 'queries',              // summary prints "12/12 queries"
  files: ['src/**/*.ts'],       // globs relative to the API root
  required: true,               // counts toward the verdict (default true)
  check(file, ctx) {            // ts-morph SourceFile; ctx: project, checker, apiRoot, exec, task, rel(file)
    const failures = [];        // { line, col?, message, fix? } → one FAIL line each, with file:line:col
    // …
    return { checked: 3, failures };  // checked = 0 in every file → the rule prints n/a
  },
});
```

The rule joins `harness check --api <path>` immediately with its own per-file lines and summary line, and becomes part
of the finish gate. For whole-project checks use `checkProject(ctx)` returning `{ files: [{ file, checked, failures }] }`
or `{ unproven: 'reason' }`. Route-aware helpers (`allRoutes`, `routeRefs`, `zodObjectKeys`) are in `core/analysis.ts`.
Complete examples: `examples/extensions/orm-explicit-columns/` (ORM validator) and
`examples/extensions/no-console-in-handlers/` (linter rule), each with a fixture API.

## A hook

```ts
// plugins/hooks/no-big-writes/index.ts
import { defineHook } from '../../../core/sdk.js';

export default defineHook({
  id: 'no-big-writes',
  phase: 'pre',                 // 'pre' can block a call; 'post' sees ctx.output
  order: 50,                    // lower runs first
  matches: (call, ctx) => ctx.tool.writes === true,
  run(call, ctx) {
    const input = ctx.input;    // the Zod-parsed tool input
    // return { decision: 'pass' } | { decision: 'record', note } | { decision: 'block', reason, fix }
    return { decision: 'pass' };
  },
});
```

Every decision is logged to `runs/<id>/events.jsonl` with exit status pass=0, record=1, block=2. A block's `reason`
and `fix` go back to the model; say what to do next.

## A context fetcher

```ts
// plugins/context/glossary/index.ts
import { defineContext } from '../../../core/sdk.js';

export default defineContext({
  name: 'glossary',
  description: 'Domain terms by key',
  fetch(key, ctx) { return '…one entry…'; },     // just in time, via a tool calling ctx.context('glossary', key)
  frontLoad(ctx) { return '…everything…'; },     // what baseline mode puts up front (token report)
});
```

## A driver

Copy `drivers/_template`. Everything vendor-specific stays inside the driver folder: message translation, tool-schema
shape, retries, model id (read from env inside the driver), usage normalisation (input tokens = the full context
processed that turn, cached included). Declare `envKeys` (any one authenticates) and `envVars` (optional settings)
so `harness doctor` can report them by name. Provider names may appear only under `drivers/` — the leak test fails
otherwise.

## Prove it

`scripts/extension-demo.sh` copies each example into `plugins/`, shows `git diff --stat` (only the plugin folder),
asserts nothing under `core/` changed, runs `harness plugins` and `harness check --api <fixture>`, then removes it.
`test/extensibility.test.ts` does the same in a temp copy.
