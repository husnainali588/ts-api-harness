import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export default defineTool({
  name: 'get_task',
  description: 'Show the task (brief, fields, behaviours or verbatim).',
  fetch: true,
  input: z.object({ section: z.enum(['brief', 'fields', 'behaviours', 'verbatim']).default('brief') }),
  async run(input, ctx) {
    return { summary: await ctx.context('task', input.section), stub: `[get_task ${input.section} — dropped, re-run if needed]` };
  },
});
