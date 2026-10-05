import { z } from 'zod';
import { defineTool, renderTaskBrief } from '../../../core/sdk.js';

export default defineTool({
  name: 'get_task',
  description: 'Show the task: resource, fields, behaviours. Pass verbatim=true for the task file exactly as written (read-only).',
  input: z.object({ verbatim: z.boolean().default(false) }),
  run(input, ctx) {
    return input.verbatim
      ? { summary: ctx.task.text, stub: '[get_task verbatim — dropped, re-run if needed]' }
      : { summary: renderTaskBrief(ctx.task), stub: '[get_task — dropped, re-run if needed]' };
  },
});
