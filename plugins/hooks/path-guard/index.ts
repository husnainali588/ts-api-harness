// G1 — path & scope guard (spec §6 G1, §5.5 model workspace). Pre-hook on every tool call that names a path.
// Reads and writes stay inside the API root; the model never writes its own judges.
import { relative } from 'node:path';
import { defineHook, type HookContext } from '../../../core/sdk.js';

const PATH_KEYS = ['path', 'dir'] as const;

/** Never readable or writable: secrets, git internals, harness state, installed packages. */
const HIDDEN: readonly RegExp[] = [/(^|\/)\.env($|\.)/, /(^|\/)\.git($|\/)/, /(^|\/)\.harness($|\/)/, /(^|\/)node_modules($|\/)/];

/** Readable, never writable by the model: test-runner, compiler, lint and package config (spec §1.7). */
const PROTECTED: readonly RegExp[] = [
  /(^|\/)package(-lock)?\.json$/,
  /(^|\/)(npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|\.npmrc)$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(vitest|vite|jest)\.(config|workspace)\.[^/]+$/,
  /(^|\/)vitest\.setup\.[^/]+$/,
  /(^|\/)(eslint\.config\.[^/]+|\.eslintrc[^/]*)$/,
  /(^|\/)(\.prettierrc[^/]*|biome\.json)$/,
];

export function pathsOf(input: unknown): string[] {
  if (typeof input !== 'object' || input === null) return [];
  const found: string[] = [];
  for (const key of PATH_KEYS) {
    if (key in input) {
      const value: unknown = Reflect.get(input, key);
      if (typeof value === 'string') found.push(value);
    }
  }
  return found;
}

function workspaceRel(ctx: HookContext, abs: string): string {
  return relative(ctx.resolvePath('.'), abs).split('\\').join('/').toLowerCase();
}

export default defineHook({
  id: 'path-guard',
  phase: 'pre',
  order: 10,
  matches: (_call, ctx) => pathsOf(ctx.input).length > 0,
  run(_call, ctx) {
    const writes = ctx.tool.writes === true;
    for (const path of pathsOf(ctx.input)) {
      let abs: string;
      try {
        abs = ctx.resolvePath(path);
      } catch (error) {
        return {
          decision: 'block',
          reason: `${path} is outside your workspace (${error instanceof Error ? error.message : String(error)}).`,
          fix: 'Use a path relative to the API root, without "..", absolute prefixes or symlinks that lead out.',
        };
      }
      const rel = workspaceRel(ctx, abs);
      if (HIDDEN.some((re) => re.test(rel))) {
        return { decision: 'block', reason: `${path} is off-limits (secrets, git, harness state or installed packages).`, fix: 'Work only with the API source and tests.' };
      }
      if (writes && PROTECTED.some((re) => re.test(rel))) {
        return {
          decision: 'block',
          reason: `${path} is harness-owned configuration and cannot be written by the model.`,
          fix: 'Leave config as it is; use add_dependency for packages and change source or test files instead.',
        };
      }
      const scope = ctx.state.acceptedScope;
      if (writes && ctx.task.mode === 'brownfield' && scope === null) {
        return {
          decision: 'block',
          reason: `no scope accepted yet for this change to an existing API.`,
          fix: 'Call propose_scope with the files you need to change and a reason, then retry.',
        };
      }
      if (writes && scope !== null && !scope.map((s) => s.toLowerCase()).includes(rel)) {
        return {
          decision: 'block',
          reason: `${path} is outside the accepted scope (${scope.join(', ') || 'empty'}).`,
          fix: 'Call propose_scope with this file and a reason, then retry.',
        };
      }
    }
    return { decision: 'pass' };
  },
});
