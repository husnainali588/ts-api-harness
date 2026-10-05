import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

const CAP = 40;

export default defineTool({
  name: 'search_code',
  description: `Search the API workspace for a regular expression; returns file:line hits (max ${CAP}).`,
  input: z.object({
    pattern: z.string().min(1).describe('JavaScript regular expression'),
    glob: z.string().default('**/*.ts').describe('files to search, relative to the API root'),
    ignoreCase: z.boolean().default(false),
  }),
  async run(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.ignoreCase ? 'i' : '');
    } catch (e) {
      return { summary: `invalid pattern: ${e instanceof Error ? e.message : String(e)}`, isError: true };
    }
    if (input.glob.split('/').includes('..')) return { summary: 'glob may not contain ".."', isError: true };
    const root = ctx.resolvePath('.');
    const files = (await fg(input.glob, { cwd: root, onlyFiles: true, ignore: ['**/node_modules/**', '**/.git/**'], followSymbolicLinks: false })).sort();
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(join(root, file), 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (re.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
        });
    }
    const shown = hits.slice(0, CAP).join('\n');
    return {
      summary: `${hits.length} hit(s) for /${input.pattern}/ in ${files.length} file(s)${hits.length === 0 ? '' : `:\n${shown}`}${hits.length > CAP ? `\n… ${hits.length - CAP} more; narrow the pattern or glob` : ''}`,
      ...(hits.length > CAP ? { raw: hits.join('\n') } : {}),
      stub: `[search_code /${input.pattern}/: ${hits.length} hits — dropped, re-run if needed]`,
    };
  },
});
