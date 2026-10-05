import fg from 'fast-glob';
import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

const CAP = 200;

export default defineTool({
  name: 'list_files',
  description: 'List file paths in the API workspace (paths only, capped). Optional dir and glob, e.g. glob "src/**/*.ts".',
  input: z.object({
    dir: z.string().default('.').describe('directory relative to the API root'),
    glob: z.string().default('**/*').describe('glob relative to dir'),
  }),
  async run(input, ctx) {
    const cwd = ctx.resolvePath(input.dir);
    if (input.glob.split('/').includes('..')) return { summary: 'glob may not contain ".."', isError: true };
    const files = (
      await fg(input.glob, { cwd, onlyFiles: true, dot: true, ignore: ['**/node_modules/**', '**/.git/**'], followSymbolicLinks: false })
    ).sort();
    const shown = files.slice(0, CAP);
    const more = files.length > CAP ? `\n… ${files.length - CAP} more; narrow dir or glob` : '';
    return {
      summary: `${files.length} file(s) in ${input.dir}:\n${shown.join('\n')}${more}`,
      ...(files.length > CAP ? { raw: files.join('\n') } : {}),
      stub: `[list_files ${input.dir} ${input.glob}: ${files.length} files — dropped, re-run if needed]`,
    };
  },
});
