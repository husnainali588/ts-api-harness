import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export default defineTool({
  name: 'get_standard',
  description: 'Fetch a standards doc: template, tdd, or a rule id (e.g. rest-conventions).',
  fetch: true,
  input: z.object({ id: z.string().min(1) }),
  async run(input, ctx) {
    return { summary: await ctx.context('standards', input.id), stub: `[get_standard ${input.id} — dropped, re-fetch if needed]` };
  },
});
