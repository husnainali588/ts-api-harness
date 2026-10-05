// G2 — observed red (spec §6 G2). A source file under src/ may be written only after a mapped test case was seen
// failing by the harness's own runner. Observations come from run_tests, never from the model.
import { relative } from 'node:path';
import { defineHook, type HookContext } from '../../../core/sdk.js';

const isTest = (rel: string) => /\.(test|spec)\.ts$/.test(rel);
const isSource = (rel: string) => /^src\/.+\.ts$/.test(rel) && !isTest(rel) && !rel.endsWith('.d.ts');
const conventionTest = (rel: string) => rel.replace(/^src\//, 'test/').replace(/\.ts$/, '.test.ts');

function targetOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('path' in input)) return undefined;
  const value: unknown = Reflect.get(input, 'path');
  return typeof value === 'string' ? value : undefined;
}

function sourceTarget(ctx: HookContext): string | undefined {
  const path = targetOf(ctx.input);
  if (ctx.tool.writes !== true || path === undefined) return undefined;
  const rel = relative(ctx.resolvePath('.'), ctx.resolvePath(path)).split('\\').join('/');
  return isSource(rel) ? rel : undefined;
}

export default defineHook({
  id: 'observed-red',
  phase: 'pre',
  order: 20,
  matches: (_call, ctx) => sourceTarget(ctx) !== undefined,
  run(_call, ctx) {
    const rel = sourceTarget(ctx) ?? '';
    const mapped = ctx.state.mappedTests(rel);
    const red = ctx.state.redCases.filter((c) => mapped.includes(c.file));
    if (red.length > 0) {
      return { decision: 'record', note: `${rel} unlocked by red ${red.map((c) => `${c.file} › ${c.name}`).slice(0, 3).join('; ')}` };
    }
    const conv = conventionTest(rel);
    const reason =
      mapped.length === 0
        ? `${rel} has no mapped test (no test imports it and ${conv} does not exist).`
        : `${rel} has no mapped test seen failing (mapped: ${mapped.join(', ')}; none recorded red by run_tests).`;
    return {
      decision: 'block',
      reason: `observed-red: ${reason}`,
      fix: `Write ${conv} (or a test that imports ${rel}) with a test for the behaviour, call run_tests, see it fail, then retry.`,
    };
  },
});
