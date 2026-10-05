// Blocks writes whose content is a history placeholder (found in a live run: the model copied the compaction marker
// "[N chars elided from history]" from its own earlier calls into new files). The marker is not file content.
import { defineHook } from '../../../core/sdk.js';

const PLACEHOLDER = /\[\d+ chars elided from history\]|— (dropped|content dropped)( from history)?(, re-(run|read|fetch) if needed)?\]/;

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

export default defineHook({
  id: 'placeholder-guard',
  phase: 'pre',
  order: 5,
  matches: (_call, ctx) => ctx.tool.writes === true,
  run(_call, ctx) {
    const hit = strings(ctx.input).find((s) => PLACEHOLDER.test(s));
    if (hit === undefined) return { decision: 'pass' };
    return {
      decision: 'block',
      reason: `the content contains a history placeholder (${PLACEHOLDER.exec(hit)?.[0] ?? 'elided'}), not real code: older call inputs are shortened in your history, the files on disk are complete.`,
      fix: 'Write the full, real file content (read_file the current file first if you need it), or use edit_file for a small change.',
    };
  },
});
