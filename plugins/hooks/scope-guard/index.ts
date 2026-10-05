// G1 extension for existing APIs (spec §8): no write before an accepted scope, and none outside it.
import { relative } from 'node:path';
import { defineHook } from '../../../core/sdk.js';

function targetOf(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null || !('path' in input)) return undefined;
  const value: unknown = Reflect.get(input, 'path');
  return typeof value === 'string' ? value : undefined;
}

export default defineHook({
  id: 'scope-guard',
  phase: 'pre',
  order: 15,
  matches: (_call, ctx) => ctx.task.mode === 'brownfield' && ctx.tool.writes === true && targetOf(ctx.input) !== undefined,
  run(_call, ctx) {
    const path = targetOf(ctx.input) ?? '';
    const rel = relative(ctx.resolvePath('.'), ctx.resolvePath(path)).split('\\').join('/');
    const scope = ctx.state.acceptedScope;
    if (scope === null) {
      return { decision: 'block', reason: 'no scope accepted yet for this change to an existing API.', fix: 'Call propose_scope with the files you need to change (tests included) and a reason, then retry.' };
    }
    if (!scope.includes(rel)) {
      return { decision: 'block', reason: `${rel} is outside the accepted scope (${scope.join(', ')}).`, fix: 'Call propose_scope with this file and a reason, then retry.' };
    }
    return { decision: 'pass' };
  },
});
