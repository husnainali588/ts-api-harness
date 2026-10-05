import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export default defineTool({
  name: 'edit_file',
  description: 'Replace an exact string in a file. oldString must match exactly once unless replaceAll is true.',
  writes: true,
  input: z.object({
    path: z.string().describe('path relative to the API root'),
    oldString: z.string().min(1),
    newString: z.string(),
    replaceAll: z.boolean().default(false),
  }),
  run(input, ctx) {
    const abs = ctx.resolvePath(input.path);
    if (!existsSync(abs)) return { summary: `${input.path} does not exist; use write_file to create it.`, isError: true };
    const text = readFileSync(abs, 'utf8');
    const count = text.split(input.oldString).length - 1;
    if (count === 0) return { summary: `oldString not found in ${input.path}. Re-read the file and copy the exact text.`, isError: true };
    if (count > 1 && !input.replaceAll) {
      return { summary: `oldString matches ${count} times in ${input.path}; add surrounding lines to make it unique or set replaceAll.`, isError: true };
    }
    const next = input.replaceAll ? text.split(input.oldString).join(input.newString) : text.replace(input.oldString, () => input.newString);
    writeFileSync(abs, next);
    return {
      summary: `edited ${input.path} (${input.replaceAll ? count : 1} replacement${count > 1 && input.replaceAll ? 's' : ''})`,
      wrote: [input.path],
      stub: `[edit_file ${input.path} — dropped from history]`,
    };
  },
});
