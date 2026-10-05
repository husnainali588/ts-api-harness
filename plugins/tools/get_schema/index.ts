import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export default defineTool({
  name: 'get_schema',
  description: 'Fetch one Zod schema from the API by name.',
  fetch: true,
  input: z.object({ name: z.string().min(1) }),
  async run(input, ctx) {
    return { summary: await ctx.context('schemas', input.name), stub: `[get_schema ${input.name} — dropped, re-fetch if needed]` };
  },
});
