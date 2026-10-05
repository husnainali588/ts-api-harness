// Blocks writes that import a package the API does not have (found in paid runs: the model imported `uuid` twice and
// broke the app). Allowed: relative imports, Node builtins (with or without `node:`), and packages in the API's
// package.json dependencies/devDependencies.
import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { relative } from 'node:path';
import { defineHook, type HookContext } from '../../../core/sdk.js';

const SPECIFIER = /(?:^|[\s;])(?:import|export)\s[^'"`]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;(=])import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;])import\s+['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;
const BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, '')));

function str(input: unknown, key: string): string | undefined {
  if (typeof input !== 'object' || input === null || !(key in input)) return undefined;
  const v: unknown = Reflect.get(input, key);
  return typeof v === 'string' ? v : undefined;
}

/** Package name of a bare specifier (`@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`); undefined if not bare. */
export function packageOf(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export function importedPackages(code: string): string[] {
  const out = new Set<string>();
  for (const m of code.matchAll(SPECIFIER)) {
    const pkg = packageOf(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
    if (pkg !== undefined && pkg !== '' && !BUILTINS.has(pkg)) out.add(pkg);
  }
  return [...out];
}

function installed(ctx: HookContext): string[] {
  const path = ctx.resolvePath('package.json');
  if (!existsSync(path)) return [];
  const pkg: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof pkg !== 'object' || pkg === null) return [];
  const names = (key: string): string[] => {
    const deps: unknown = Reflect.get(pkg, key);
    return typeof deps === 'object' && deps !== null ? Object.keys(deps) : [];
  };
  return [...names('dependencies'), ...names('devDependencies')];
}

function newCode(ctx: HookContext): string | undefined {
  if (ctx.tool.name === 'write_file') return str(ctx.input, 'content');
  if (ctx.tool.name === 'edit_file') return str(ctx.input, 'newString');
  return undefined;
}

export default defineHook({
  id: 'import-guard',
  phase: 'pre',
  order: 30,
  matches: (_call, ctx) => {
    const path = str(ctx.input, 'path');
    if (ctx.tool.writes !== true || path === undefined) return false;
    return /\.(c|m)?(t|j)sx?$/.test(relative(ctx.resolvePath('.'), ctx.resolvePath(path)));
  },
  run(_call, ctx) {
    const code = newCode(ctx);
    if (code === undefined) return { decision: 'pass' };
    const have = installed(ctx);
    const missing = importedPackages(code).filter((p) => !have.includes(p) && !have.includes(`@types/${p}`));
    if (missing.length === 0) return { decision: 'pass' };
    return {
      decision: 'block',
      reason: `imports ${missing.map((m) => `"${m}"`).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not installed. Installed: ${have.join(', ') || 'none'} (+ Node builtins via node:).`,
      fix: 'Use an installed package or a Node builtin instead — for ids use randomUUID from "node:crypto". Then retry.',
    };
  },
});
