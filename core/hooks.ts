// Pre/post hook pipeline (spec §5.3). Every decision is logged with an exit status: pass=0, record=1, block=2.
// A hook that throws blocks the call (fail closed).
import type { ToolCall } from './driver.js';
import type { Loaded } from './registry.js';
import type { HookContext, HookDefinition, HookOutcome } from './sdk.js';

export const EXIT = { pass: 0, record: 1, block: 2 } as const;

export interface PipelineResult {
  blocked: { hook: string; reason: string; fix: string } | null;
  notes: string[];
}

export async function runHooks(
  phase: 'pre' | 'post',
  hooks: readonly Loaded<HookDefinition>[],
  call: ToolCall,
  ctx: HookContext,
  log: (entry: Record<string, unknown>) => void,
): Promise<PipelineResult> {
  const notes: string[] = [];
  for (const { def } of hooks) {
    if (def.phase !== phase) continue;
    let outcome: HookOutcome;
    try {
      if (!def.matches(call, ctx)) continue;
      outcome = await def.run(call, ctx);
    } catch (error) {
      outcome = {
        decision: 'block',
        reason: `hook ${def.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        fix: 'Try a different call; this one cannot be verified as safe.',
      };
    }
    log({ type: 'hook', phase, hook: def.id, tool: call.name, callId: call.id, exit: EXIT[outcome.decision], ...outcome });
    if (outcome.decision === 'record') notes.push(`${def.id}: ${outcome.note}`);
    if (outcome.decision === 'block') {
      // A post hook cannot undo a call; its block is reported back to the model as an error.
      return { blocked: { hook: def.id, reason: outcome.reason, fix: outcome.fix }, notes };
    }
  }
  return { blocked: null, notes };
}

export function blockMessage(blocked: { hook: string; reason: string; fix: string }): string {
  return `BLOCKED ${blocked.hook}: ${blocked.reason} ${blocked.fix}`;
}
