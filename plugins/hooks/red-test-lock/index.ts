// Red-test lock (red-team fix): once a source file mapped to a red test has been written, the bodies of that file's
// red test cases are frozen. The model can add tests, but cannot weaken the one it turned green (G3 continuity only
// checks that the case still exists and passes, not that it still asserts the same thing).
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { defineHook, type HookContext } from '../../../core/sdk.js';

const LOAD_CASE = '(file failed to load)';
const isTestFile = (rel: string) => rel.startsWith('test/') && /\.(test|spec)\.ts$/.test(rel);
const isSource = (rel: string) => /^src\/.+\.ts$/.test(rel) && !/\.(test|spec)\.ts$/.test(rel);

function str(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null || !(key in input)) return undefined;
  const v: unknown = Reflect.get(input, key);
  return typeof v === 'string' ? v : undefined;
}

function targetRel(ctx: HookContext): string | undefined {
  const path = str(ctx.input, 'path');
  if (ctx.tool.writes !== true || path === undefined) return undefined;
  const rel = relative(ctx.resolvePath('.'), ctx.resolvePath(path)).split('\\').join('/');
  return isTestFile(rel) ? rel : undefined;
}

/** title → callback text for every it()/test() call (also inside describe blocks). */
export function caseBodies(text: string): Map<string, string> {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile('t.ts', text, { overwrite: true });
  const out = new Map<string, string>();
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression().getText();
    if (!/^(it|test)(\.(only|skip|concurrent|sequential|fails))?$/.test(callee)) continue;
    const [title, fn] = call.getArguments();
    if (title === undefined || fn === undefined) continue;
    const name = Node.isStringLiteral(title) || Node.isNoSubstitutionTemplateLiteral(title) ? title.getLiteralValue() : title.getText();
    out.set(name, `${callee}(${fn.getText()})`); // the modifier counts: it.skip/it.only/it.fails change the case
  }
  return out;
}

function nextContent(ctx: HookContext, abs: string): string | undefined {
  if (ctx.tool.name === 'write_file') return str(ctx.input, 'content');
  if (ctx.tool.name === 'edit_file') {
    const before = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
    const oldString = str(ctx.input, 'oldString') ?? '';
    const newString = str(ctx.input, 'newString') ?? '';
    const all = typeof ctx.input === 'object' && ctx.input !== null && Reflect.get(ctx.input, 'replaceAll') === true;
    return all ? before.split(oldString).join(newString) : before.replace(oldString, () => newString);
  }
  return undefined; // an unknown writer: other guards apply
}

export default defineHook({
  id: 'red-test-lock',
  phase: 'pre',
  order: 25,
  matches: (_call, ctx) => {
    const rel = targetRel(ctx);
    return rel !== undefined && ctx.state.redCases.some((c) => c.file === rel);
  },
  run(_call, ctx) {
    const rel = targetRel(ctx) ?? '';
    const unlockedSources = ctx.state.writtenFiles.filter((f) => isSource(f) && ctx.state.mappedTests(f).includes(rel));
    if (unlockedSources.length === 0) return { decision: 'pass' }; // still designing the test: no source written yet
    const abs = ctx.resolvePath(rel);
    const next = nextContent(ctx, abs);
    if (next === undefined || !existsSync(abs)) return { decision: 'pass' };
    const before = caseBodies(readFileSync(abs, 'utf8'));
    const after = caseBodies(next);
    const red = ctx.state.redCases.filter((c) => c.file === rel);
    const locked = red.some((c) => c.name === LOAD_CASE)
      ? [...before.keys()]
      : red.map((c) => [...before.keys()].filter((t) => c.name === t || c.name.endsWith(` ${t}`)).sort((a, b) => b.length - a.length)[0]).filter((t): t is string => t !== undefined);
    const changed = locked.filter((t) => after.get(t) !== before.get(t));
    if (changed.length === 0) return { decision: 'pass' };
    return {
      decision: 'block',
      reason: `red test(s) ${changed.map((t) => `"${t}"`).join(', ')} in ${rel} are locked: ${unlockedSources.join(', ')} was written against them.`,
      fix: 'Keep those test cases exactly as they are; add new test cases (or a new test file) for anything else.',
    };
  },
});
