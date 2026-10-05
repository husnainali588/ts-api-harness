// G2 — observed red (spec §6 G2). A source file under src/ may be written only after a mapped test case was seen
// failing by the harness's own runner. Observations come from run_tests, never from the model.
// Code must be TypeScript under src/ (source) or test/ (tests), so nothing escapes the gate by where it is written.
import { relative } from 'node:path';
import { defineHook, type HookContext, type HookOutcome } from '../../../core/sdk.js';

const isTestName = (rel: string) => /\.(test|spec)\.ts$/.test(rel);
const isSource = (rel: string) => /^src\/.+\.ts$/.test(rel) && !isTestName(rel) && !rel.endsWith('.d.ts');
const isCode = (rel: string) => /\.(c|m)?(t|j)sx?$/.test(rel);
const conventionTest = (rel: string) => rel.replace(/^src\//, 'test/').replace(/\.ts$/, '.test.ts');

function targetOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('path' in input)) return undefined;
  const value: unknown = Reflect.get(input, 'path');
  return typeof value === 'string' ? value : undefined;
}

function codeTarget(ctx: HookContext): string | undefined {
  const path = targetOf(ctx.input);
  if (ctx.tool.writes !== true || path === undefined) return undefined;
  const rel = relative(ctx.resolvePath('.'), ctx.resolvePath(path)).split('\\').join('/');
  // Tests and test helpers under test/ are free to write; everything else that is code is gated here.
  return isCode(rel) && !(rel.startsWith('test/') && rel.endsWith('.ts') && !/\.(c|m)ts$/.test(rel)) ? rel : undefined;
}

const block = (reason: string, fix: string): HookOutcome => ({ decision: 'block', reason: `observed-red: ${reason}`, fix });

export default defineHook({
  id: 'observed-red',
  phase: 'pre',
  order: 20,
  matches: (_call, ctx) => codeTarget(ctx) !== undefined,
  run(_call, ctx) {
    const rel = codeTarget(ctx) ?? '';
    if (!rel.endsWith('.ts') || /\.(c|m)ts$/.test(rel)) return block(`${rel} is not a .ts file.`, 'Write TypeScript source as src/**/*.ts and tests as test/**/*.test.ts.');
    if (isTestName(rel)) return block(`${rel} is a test file outside test/.`, `Put tests under test/ (e.g. ${rel.replace(/^src\//, 'test/')}).`);
    if (!isSource(rel)) return block(`${rel} is outside src/ and test/; code there would skip the gates.`, 'Put source under src/ and tests under test/.');

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
    return block(reason, `Write ${conv} (or a test that imports ${rel}) with a test for the behaviour, call run_tests, see it fail, then retry.`);
  },
});
