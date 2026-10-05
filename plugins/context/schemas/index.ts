// Zod schemas declared in the API, fetched by name with get_schema(name); baseline mode front-loads all of them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fg from 'fast-glob';
import { defineContext } from '../../../core/sdk.js';

interface Found {
  name: string;
  file: string;
  text: string;
}

/** `export const Name = z...` declarations (to the end of the statement) in src/. */
function schemas(apiRoot: string): Found[] {
  const out: Found[] = [];
  for (const file of fg.sync('src/**/*.ts', { cwd: apiRoot, ignore: ['**/node_modules/**'] }).sort()) {
    const text = readFileSync(join(apiRoot, file), 'utf8');
    const re = /^(export )?const ([A-Z]\w*) = (z\b|pageOf\(|[A-Z]\w*\.(extend|pick|omit|partial)\()[\s\S]*?;\n/gm;
    for (const m of text.matchAll(re)) out.push({ name: m[2] ?? '', file, text: m[0].trim() });
  }
  return out;
}

export default defineContext({
  name: 'schemas',
  description: 'Zod schemas declared in the API, by name',
  fetch(key, ctx) {
    const all = schemas(ctx.apiRoot);
    const hit = all.find((s) => s.name === key);
    if (hit !== undefined) return `// ${hit.file}\n${hit.text}`;
    return `no schema "${key}". Declared: ${all.map((s) => s.name).join(', ') || 'none yet'}`;
  },
  frontLoad(ctx) {
    return schemas(ctx.apiRoot)
      .map((s) => `// ${s.file}\n${s.text}`)
      .join('\n\n');
  },
});
