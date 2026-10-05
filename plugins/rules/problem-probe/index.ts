// Our own addition: schema-driven negative probing. Static checks cannot see framework defaults (HTML 404s for
// unknown routes, body-parser errors on malformed JSON); this boots the API and asks it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Node, SyntaxKind } from 'ts-morph';
import { defineRule, type ProjectFileResult, type RuleContext } from '../../../core/sdk.js';
import { allRoutes, firstParamName, rel, schemaParsing, type RouteSite } from '../_shared/api.js';
import type { AstRoute, ProbeInput, ProbeOutput, SchemaRef } from './runner.js';

const RUNNER = fileURLToPath(new URL('./runner.ts', import.meta.url));
const WORK_DIR = fileURLToPath(new URL('../../../.harness/probe/', import.meta.url));

function exportedRef(node: Node | undefined, ctx: RuleContext): SchemaRef | undefined {
  if (node === undefined || !Node.isIdentifier(node)) return undefined;
  let symbol = node.getSymbol();
  const aliased = symbol?.getAliasedSymbol();
  if (aliased !== undefined) symbol = aliased;
  const decl = symbol?.getDeclarations()[0];
  if (decl === undefined || !Node.isVariableDeclaration(decl) || !decl.isExported()) return undefined;
  return { file: rel(ctx.apiRoot, decl.getSourceFile()), name: decl.getName() };
}

function astRoute(route: RouteSite, ctx: RuleContext): AstRoute {
  const out: AstRoute = { method: route.method, path: route.path, line: route.line, file: route.file };
  for (const fn of route.handlers) {
    const req = firstParamName(fn);
    for (const access of fn.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      const source = access.getName();
      if (req === undefined || access.getExpression().getText() !== req || (source !== 'body' && source !== 'query' && source !== 'params')) continue;
      const ref = exportedRef(schemaParsing(access), ctx);
      if (ref !== undefined) out[source] = ref;
    }
  }
  return out;
}

export default defineRule({
  id: 'problem-probe',
  description: 'Boots the API and probes every route with schema-generated bad requests; every error must be a correct problem+json',
  unit: 'probes',
  files: ['src/app.ts'],
  async checkProject(ctx) {
    if (!existsSync(join(ctx.apiRoot, 'src', 'app.ts'))) return { unproven: 'src/app.ts not found (cannot boot the app)' };
    mkdirSync(WORK_DIR, { recursive: true });
    const id = randomUUID();
    const input: ProbeInput = {
      apiRoot: ctx.apiRoot,
      astRoutes: allRoutes(ctx.project, ctx.apiRoot).map((r) => astRoute(r, ctx)),
      uniqueFields: (ctx.task?.fields ?? []).filter((f) => f.unique).map((f) => f.name),
      outFile: join(WORK_DIR, `${id}.out.json`),
    };
    const inputFile = join(WORK_DIR, `${id}.in.json`);
    writeFileSync(inputFile, JSON.stringify(input));
    const tsx = import.meta.resolve('tsx');
    const res = await ctx.exec(process.execPath, ['--import', tsx, RUNNER, inputFile], { timeoutMs: 180_000 });
    if (!existsSync(input.outFile)) return { unproven: `probe runner failed (exit ${res.code}): ${res.stderr.split('\n')[0] ?? ''}`.slice(0, 200) };
    const output = JSON.parse(readFileSync(input.outFile, 'utf8')) as ProbeOutput;
    rmSync(input.outFile, { force: true });
    rmSync(inputFile, { force: true });
    if (output.error !== undefined) return { unproven: output.error };
    ctx.saveRaw('problem-probe', JSON.stringify(output, null, 2));

    const groups = new Map<string, ProjectFileResult>();
    for (const probe of output.probes) {
      const key = `${probe.route} · ${probe.family}`;
      const entry = groups.get(key) ?? { file: key, checked: 0, failures: [] };
      entry.checked += 1;
      if (probe.problems.length > 0) entry.failures.push({ line: 0, message: `${probe.request} → ${probe.status}: ${probe.problems.join('; ')}`.slice(0, 300) });
      groups.set(key, entry);
    }
    if (groups.size === 0) return { unproven: 'no probes could be generated' };
    return { files: [...groups.values()] };
  },
});
