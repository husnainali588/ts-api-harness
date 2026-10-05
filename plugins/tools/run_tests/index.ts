import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export default defineTool({
  name: 'run_tests',
  description: 'Run all tests; returns PASS/FAIL counts and failures. Only this records red/green.',
  input: z.object({}),
  async run(_input, ctx) {
    const out = await ctx.services.runTests();
    return { ...out, stub: `[run_tests turn ${ctx.turn}: ${out.summary.split(' — ')[0] ?? ''} — details dropped]` };
  },
});
