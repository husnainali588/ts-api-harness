// problem-probe: passes on the reference APIs, fails on the framework defaults static checks cannot see.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChecks, type CheckReport } from '../core/checks.js';
import { loadRegistry, type Registry } from '../core/registry.js';
import { loadTask } from '../core/task.js';
import { REPO_ROOT, apiCopy, mutate, removeDir, tempDir } from './helpers.js';

let registry: Registry;
const dirs: string[] = [];
beforeAll(async () => {
  const full = await loadRegistry(REPO_ROOT);
  registry = { ...full, rules: full.rules.filter((r) => r.def.id === 'problem-probe') };
});
afterAll(() => {
  for (const d of dirs) removeDir(d);
});

const task = loadTask('tasks/users.yaml', REPO_ROOT);

async function probe(api: string): Promise<CheckReport> {
  const reports = tempDir('probe-reports');
  dirs.push(reports);
  return runChecks({ apiRoot: api, registry, runId: 'probe', reportsRoot: reports, task });
}

function copy(source = 'test/fixtures/good-api') {
  const dir = apiCopy(source, 'probe');
  dirs.push(dir);
  return dir;
}

function probeFailures(report: CheckReport): string[] {
  return (report.rules[0]?.files ?? []).flatMap((f) => f.failures.map((x) => `${f.file}: ${x.message}`));
}

describe('problem-probe passes', () => {
  it('on good-api via createApp().routeTable', async () => {
    const report = await probe(copy());
    expect(report.rules[0]?.status).toBe('pass');
    expect(report.rules[0]?.checked).toBeGreaterThanOrEqual(20);
    const families = new Set((report.rules[0]?.files ?? []).map((f) => f.file.split(' · ')[1]));
    for (const family of ['unknown-route', 'malformed-json', 'empty-body', 'missing-field', 'wrong-type', 'malformed-id', 'unknown-id', 'wrong-method', 'list-bounds', 'duplicate', 'idempotency']) {
      expect(families).toContain(family);
    }
  });

  it('on the hand-written sample API via static routes', async () => {
    const report = await probe(copy('fixtures/sample-api'));
    expect(report.rules[0]?.status).toBe('pass');
  });
});

describe('problem-probe fails', () => {
  it('(a) without the 404 catch-all', async () => {
    const api = copy();
    mutate(api, 'src/app.ts', '  app.use(notFoundHandler);\n', '');
    const fails = probeFailures(await probe(api));
    expect(fails.some((f) => /app · unknown-route: .*not application\/problem\+json/.test(f))).toBe(true);
  });

  it('(b) without the malformed-JSON handler', async () => {
    const api = copy();
    mutate(api, 'src/http/problem.ts', "  if (errorType(err) === 'entity.parse.failed') {", "  if (errorType(err) === 'never') {");
    mutate(api, 'src/http/problem.ts', '  const status = clientStatus(err);', '  const status = clientStatus(undefined);');
    const fails = probeFailures(await probe(api));
    expect(fails.some((f) => /malformed-json: .*→ 500: status 500 not in allowed \{400\}/.test(f))).toBe(true);
  });

  it('(c) when errors are sent with res.json() and no problem+json media type', async () => {
    const api = copy();
    mutate(api, 'src/http/problem.ts', ".type('application/problem+json')", '');
    const fails = probeFailures(await probe(api));
    expect(fails.some((f) => /media type application\/json.* is not application\/problem\+json/.test(f))).toBe(true);
  });

  it('(d) when a problem body has no instance', async () => {
    const api = copy();
    mutate(api, 'src/http/problem.ts', "  instance: z.string().startsWith('/'),\n", '');
    mutate(api, 'src/http/problem.ts', ', instance: requestPath(req) }', ' }');
    const fails = probeFailures(await probe(api));
    expect(fails.some((f) => /problem\.instance missing/.test(f))).toBe(true);
  });

  it('reports UNPROVEN when the app cannot be booted', async () => {
    const api = copy();
    mutate(api, 'src/app.ts', 'export function createApp(', 'export function makeApp(');
    const report = await probe(api);
    expect(report.rules[0]?.status).toBe('unproven');
    expect(report.green).toBe(false);
  });
});
