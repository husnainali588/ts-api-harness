import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

const MAX_LINES = 200;
const MAX_CHARS = 16_000;
const OUTLINE_OVER = 60; // longer files read without a range return an outline first

const Seen = z.object({ sha: z.string(), turn: z.number() });
const DECL = /^(export\s|(async\s+)?function\s|class\s|interface\s|type\s|const\s+[A-Z]|enum\s)/;

/** Top-level declarations with line numbers: enough to pick a range, a fraction of the tokens. */
export function outline(lines: string[]): string {
  const imports = lines.filter((l) => l.startsWith('import ')).length;
  const decls = lines.flatMap((l, i) => (DECL.test(l) ? [`${String(i + 1).padStart(4)}| ${l.trim().slice(0, 140)}`] : []));
  return [`${imports} import line(s); top-level declarations:`, ...decls].join('\n');
}

export default defineTool({
  name: 'read_file',
  description: `Read file lines (numbered, max ${MAX_LINES} per call). Files over ${OUTLINE_OVER} lines without startLine/endLine return an outline; then read the range you need.`,
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
    if (input.startLine === 1 && input.endLine === undefined && lines.length > OUTLINE_OVER) {
      const full = lines.slice(0, MAX_LINES).map((line, i) => `${String(i + 1).padStart(4)}| ${line}`).join('\n');
      return {
        summary: `${input.path}: ${lines.length} lines — outline (read a range with startLine/endLine for the code):\n${outline(lines)}`,
        raw: `${input.path} lines 1-${Math.min(lines.length, MAX_LINES)} of ${lines.length}\n${full}`,
        stub: `[read_file ${input.path} outline — dropped, re-read if needed]`,
      };
    }
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
