import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export default defineTool({
  name: 'write_file',
  description: 'Create or overwrite a file in the API workspace with the full content.',
  writes: true,
  input: z.object({
    path: z.string().describe('path relative to the API root'),
    content: z.string(),
  }),
  run(input, ctx) {
    const abs = ctx.resolvePath(input.path);
    const existed = existsSync(abs);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, input.content);
    const lines = input.content.split('\n').length;
    return {
      summary: `${existed ? 'overwrote' : 'created'} ${input.path} (${lines} lines)`,
      wrote: [input.path],
      stub: `[write_file ${input.path} (${lines} lines) — content dropped from history]`,
    };
  },
});
