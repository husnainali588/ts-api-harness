// Our own addition: schema-driven negative probing. Static checks cannot see framework defaults (HTML 404s for
// unknown routes, body-parser errors on malformed JSON); this boots the API and asks it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { defineRule, type ProjectFileResult } from '../../../core/sdk.js';
import { allRoutes, routeRefs } from '../../../core/analysis.js';
import type { ProbeInput, ProbeOutput } from './runner.js';

const RUNNER = fileURLToPath(new URL('./runner.ts', import.meta.url));
const WORK_DIR = fileURLToPath(new URL('../../../.harness/probe/', import.meta.url));

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
      astRoutes: allRoutes(ctx.project, ctx.apiRoot).map((r) => routeRefs(r, ctx.apiRoot)),
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
