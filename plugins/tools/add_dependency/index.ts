// The only way the model can change package.json: an allowlisted npm install run by the harness.
import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export const ALLOWLIST: Readonly<Record<string, 'dev' | 'prod'>> = {
  zod: 'prod',
  express: 'prod',
  supertest: 'dev',
  '@types/supertest': 'dev',
  '@types/express': 'dev',
  '@types/node': 'dev',
};

export default defineTool({
  name: 'add_dependency',
  description: `Install an allowlisted npm package into the API (${Object.keys(ALLOWLIST).join(', ')}).`,
  input: z.object({ name: z.string().min(1) }),
  async run(input, ctx) {
    const kind = ALLOWLIST[input.name];
    if (kind === undefined) {
      return { summary: `"${input.name}" is not on the allowlist (${Object.keys(ALLOWLIST).join(', ')}). Solve it without the package.`, isError: true };
    }
    const res = await ctx.exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', kind === 'dev' ? '--save-dev' : '--save', input.name], {
      timeoutMs: 300_000,
    });
    if (res.code !== 0) return { summary: `npm install ${input.name} failed (exit ${res.code})`, raw: res.stderr, isError: true };
    return { summary: `installed ${input.name} (${kind})`, wrote: ['package.json'] };
  },
});
