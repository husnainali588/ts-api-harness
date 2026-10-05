// Standards documents, fetched just in time with get_standard(id); baseline mode front-loads all of them.
// `exports` is generated from the API's own src/ so the model sees the real helper names (a live model invented
// `PaginatedList`, which does not exist).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import { defineContext } from '../../../core/sdk.js';
import { DOCS } from './docs.js';

const EXPORT = /^export\s+(?:declare\s+)?(?:async\s+)?(function|const|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/** Every exported name in the API's src/, by file, with its kind and first signature line. */
export function exportsDoc(apiRoot: string): string {
  const lines: string[] = ['# Exports in src/ (import with a relative path ending in .js)'];
  for (const file of fg.sync('src/**/*.ts', { cwd: apiRoot, ignore: ['**/node_modules/**', '**/*.test.ts'] }).sort()) {
    const found = readFileSync(join(apiRoot, file), 'utf8')
      .split('\n')
      .flatMap((l) => {
        const m = EXPORT.exec(l);
        return m === null ? [] : [`  ${m[2]} (${m[1]}): ${l.trim().replace(/\s*\{$/, '').slice(0, 110)}`];
      });
    if (found.length > 0) lines.push(`${file}`, ...found);
  }
  return lines.join('\n');
}

export default defineContext({
  name: 'standards',
  description: 'How to satisfy each standards rule, the template, the observed-red cycle, and the exported helpers (by id)',
  fetch(key, ctx) {
    if (key === 'exports') return exportsDoc(ctx.apiRoot);
    const doc = DOCS[key];
    if (doc !== undefined) return doc;
    const rule = ctx.rules.find((r) => r.id === key);
    if (rule !== undefined) return `# ${rule.id}\n${rule.description} (unit: ${rule.unit})`;
    return `unknown standard "${key}". Known: exports, ${[...new Set([...Object.keys(DOCS), ...ctx.rules.map((r) => r.id)])].join(', ')}`;
  },
  frontLoad(ctx) {
    const extra = ctx.rules.filter((r) => DOCS[r.id] === undefined).map((r) => `# ${r.id}\n${r.description} (unit: ${r.unit})`);
    return [...Object.values(DOCS), exportsDoc(ctx.apiRoot), ...extra].join('\n\n');
  },
});
