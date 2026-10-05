import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export default defineTool({
  name: 'run_checks',
  description: 'Run the API standards checks (Zod boundaries, problem+json, strict tsc, unsafe TS, REST conventions, test mapping). Returns failing lines with file:line and a verdict.',
  input: z.object({}),
  async run(_input, ctx) {
    const out = await ctx.services.runChecks();
    const verdict = out.summary.split('\n').find((l) => l.startsWith('verdict')) ?? 'verdict ?';
    return { ...out, stub: `[run_checks turn ${ctx.turn}: ${verdict.replace(/\s+/g, ' ')} — details dropped]` };
  },
});
