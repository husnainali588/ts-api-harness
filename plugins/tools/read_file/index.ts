import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

const MAX_LINES = 200;
const MAX_CHARS = 16_000;

const Seen = z.object({ sha: z.string(), turn: z.number() });

export default defineTool({
  name: 'read_file',
  description: `Read file lines (numbered, max ${MAX_LINES} per call).`,
  fetch: true,
  input: z.object({
    path: z.string(),
    startLine: z.number().int().min(1).default(1),
    endLine: z.number().int().min(1).optional(),
  }),
  run(input, ctx) {
    const abs = ctx.resolvePath(input.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) return { summary: `${input.path} does not exist. Use list_files to find paths.`, isError: true };
    const text = readFileSync(abs, 'utf8');
    const lines = text.split('\n');
    const start = input.startLine;
    const end = Math.min(input.endLine ?? start + MAX_LINES - 1, start + MAX_LINES - 1, lines.length);
    const numbered = lines
      .slice(start - 1, end)
      .map((line, i) => `${String(start + i).padStart(4)}| ${line}`)
      .join('\n');
    const body = numbered.length > MAX_CHARS ? `${numbered.slice(0, MAX_CHARS)}\n… truncated; read a smaller range` : numbered;
    const header = `${input.path} lines ${start}-${end} of ${lines.length}${end < lines.length ? ' (more below)' : ''}`;
    const stub = `[read_file ${input.path}:${start}-${end} — dropped, re-read if needed]`;

    const key = `${input.path}:${start}-${end}`;
    const sha = createHash('sha256').update(text).digest('hex');
    const seen = Seen.safeParse(ctx.memory.get(key));
    ctx.memory.set(key, { sha, turn: seen.success && seen.data.sha === sha ? seen.data.turn : ctx.turn });
    if (seen.success && seen.data.sha === sha) {
      return { summary: `${input.path}:${start}-${end} unchanged since turn ${seen.data.turn}`, raw: `${header}\n${body}`, stub, cached: true };
    }
    return { summary: `${header}\n${body}`, stub };
  },
});
