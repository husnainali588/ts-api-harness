// Extensibility (brief §5.4): each grader-style addition is one new plugin folder; git sees nothing else change,
// core/ in particular; the registry picks it up and the standards check prints its own lines.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChecks } from '../core/checks.js';
import { loadRegistry } from '../core/registry.js';
import type { ToolContext } from '../core/sdk.js';
import { REPO_ROOT, apiCopy, harnessCopy, removeDir, tempDir } from './helpers.js';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });

let root: string;
const dirs: string[] = [];
beforeAll(() => {
  root = harnessCopy('ext');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'harness');
});
afterAll(() => {
  removeDir(root);
  for (const d of dirs) removeDir(d);
});

function install(name: string, kind: string): string[] {
  const target = join('plugins', kind, name);
  mkdirSync(join(root, target), { recursive: true });
  cpSync(join(REPO_ROOT, 'examples/extensions', name, 'index.ts'), join(root, target, 'index.ts'));
  git(root, 'add', '-N', target);
  return git(root, 'diff', '--name-only').split('\n').filter((l) => l !== '');
}

function uninstall(name: string, kind: string): void {
  git(root, 'reset', '-q', '--', join('plugins', kind, name));
  removeDir(join(root, 'plugins', kind, name));
}

async function checkFixture(name: string) {
  const api = apiCopy(join('examples/extensions', name, 'fixtures/api'), 'ext-api');
  const reports = tempDir('ext-reports');
  dirs.push(api, reports);
  return runChecks({ apiRoot: api, registry: await loadRegistry(root), runId: 'ext', reportsRoot: reports });
}

describe('adding a plugin touches only its own folder', () => {
  it('tool openapi_diff: discovered on the next load and works', async () => {
    const changed = install('openapi_diff', 'tools');
    expect(changed).toEqual(['plugins/tools/openapi_diff/index.ts']);
    expect(git(root, 'status', '--porcelain', '--', 'core')).toBe('');
    const tool = (await loadRegistry(root)).tools.find((t) => t.def.name === 'openapi_diff');
    expect(tool?.source).toBe('plugins/tools/openapi_diff/index.ts');
    const fixtures = join(REPO_ROOT, 'examples/extensions/openapi_diff/fixtures');
    const ctx = { resolvePath: (p: string) => join(fixtures, p) } as unknown as ToolContext;
    const out = await tool?.def.run({ before: 'before.json', after: 'after.json' }, ctx);
    expect(out?.summary).toMatch(/^3 breaking: /);
    expect(out?.raw).toContain('BREAKING removed DELETE /v1/users/{id}');
    expect(out?.raw).toContain('added    added GET /v1/users/{id}/roles');
    uninstall('openapi_diff', 'tools');
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  it('ORM validator orm-explicit-columns: joins the standards check with its own lines', async () => {
    expect(install('orm-explicit-columns', 'rules')).toEqual(['plugins/rules/orm-explicit-columns/index.ts']);
    expect(git(root, 'status', '--porcelain', '--', 'core')).toBe('');
    const report = await checkFixture('orm-explicit-columns');
    const rule = report.rules.find((r) => r.id === 'orm-explicit-columns');
    expect(rule).toMatchObject({ status: 'fail', checked: 5, failing: 2 });
    expect(report.text).toMatch(/orm-explicit-columns FAIL\s+src\/users-repo\.ts:30:10\s+prisma\.user\.findUnique on users without select/);
    expect(report.text).toMatch(/orm-explicit-columns FAIL\s+src\/users-repo\.ts:38:10\s+select\(\) with no column map/);
    uninstall('orm-explicit-columns', 'rules');
  });

  it('linter rule no-console-in-handlers: joins the standards check with its own lines', async () => {
    expect(install('no-console-in-handlers', 'rules')).toEqual(['plugins/rules/no-console-in-handlers/index.ts']);
    const report = await checkFixture('no-console-in-handlers');
    expect(report.rules.find((r) => r.id === 'no-console-in-handlers')).toMatchObject({ status: 'fail', checked: 2, failing: 1 });
    expect(report.text).toMatch(/no-console-in-handlers FAIL\s+src\/things\.ts:10:5\s+console\.log in DELETE \/v1\/things\/:id/);
    uninstall('no-console-in-handlers', 'rules');
  });

  it('a rule that passes prints a pass line (orm rule on a clean API)', async () => {
    install('orm-explicit-columns', 'rules');
    const api = apiCopy('examples/extensions/orm-explicit-columns/fixtures/api', 'ext-clean');
    dirs.push(api);
    const repo = join(api, 'src/users-repo.ts');
    const clean = readFileSync(repo, 'utf8').replace('findUnique({ where: { id } })', 'findUnique({ where: { id }, select: { id: true } })').replace('db.select().from', 'db.select({ id: "users.id" }).from');
    writeFileSync(repo, clean);
    const reports = tempDir('ext-reports');
    dirs.push(reports);
    const report = await runChecks({ apiRoot: api, registry: await loadRegistry(root), runId: 'ext', reportsRoot: reports });
    expect(report.text).toMatch(/orm-explicit-columns pass\s+src\/users-repo\.ts\s+5\/5 queries/);
    uninstall('orm-explicit-columns', 'rules');
  });
});
