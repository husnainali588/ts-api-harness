// Template tool. Copy this folder to plugins/tools/<your_tool>/ (no leading "_") and it is discovered on the next run.
import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export default defineTool({
  name: 'example_tool',
  description: 'One line the model reads: what the tool does and what it returns.',
  input: z.object({ path: z.string().describe('API-root-relative path') }),
  run(input, ctx) {
    const full = ctx.resolvePath(input.path); // throws if the path escapes the workspace
    const raw = `full output for ${full}`;
    // Return a compact summary for the model; raw output goes to disk and is referenced by path.
    return { summary: `example_tool: 1 line about ${input.path}`, raw };
  },
});
