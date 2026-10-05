import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export default defineTool({
  name: 'finish',
  description: 'Ask the harness to end the run. Its finish gate decides: tests, red→green continuity, strict tsc and standards checks must all pass.',
  input: z.object({ summary: z.string().default('').describe('one or two lines on what was done') }),
  run(input) {
    return { summary: `finish requested${input.summary === '' ? '' : `: ${input.summary}`}`, signal: 'finish' };
  },
});
