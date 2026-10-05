// Standards documents, fetched just in time with get_standard(id); baseline mode front-loads all of them.
import { defineContext } from '../../../core/sdk.js';
import { DOCS } from './docs.js';

export default defineContext({
  name: 'standards',
  description: 'How to satisfy each standards rule, the template and the observed-red cycle (by id)',
  fetch(key, ctx) {
    const doc = DOCS[key];
    if (doc !== undefined) return doc;
    const rule = ctx.rules.find((r) => r.id === key);
    if (rule !== undefined) return `# ${rule.id}\n${rule.description} (unit: ${rule.unit})`;
    return `unknown standard "${key}". Known: ${[...new Set([...Object.keys(DOCS), ...ctx.rules.map((r) => r.id)])].join(', ')}`;
  },
  frontLoad(ctx) {
    const extra = ctx.rules.filter((r) => DOCS[r.id] === undefined).map((r) => `# ${r.id}\n${r.description} (unit: ${r.unit})`);
    return [...Object.values(DOCS), ...extra].join('\n\n');
  },
});
