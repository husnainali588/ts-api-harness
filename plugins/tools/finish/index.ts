import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export default defineTool({
  name: 'finish',
  description: 'End the run; the finish gate checks tests, red→green, tsc and standards.',
  input: z.object({ summary: z.string().default('') }),
  run(input) {
    return { summary: `finish requested${input.summary === '' ? '' : `: ${input.summary}`}`, signal: 'finish' };
  },
});
