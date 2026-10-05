// Post-hook: records every successful write with the file's sha256 in events.jsonl (exit status 1 = record).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { defineHook } from '../../../core/sdk.js';

export default defineHook({
  id: 'write-log',
  phase: 'post',
  order: 900,
  matches: (_call, ctx) => ctx.tool.writes === true && ctx.output?.isError !== true && (ctx.output?.wrote?.length ?? 0) > 0,
  run(_call, ctx) {
    const notes = (ctx.output?.wrote ?? []).map((rel) => {
      const abs = ctx.resolvePath(rel);
      const sha = existsSync(abs) ? createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 12) : 'deleted';
      return `${rel} sha256:${sha}`;
    });
    return { decision: 'record', note: `wrote ${notes.join(', ')}` };
  },
});
