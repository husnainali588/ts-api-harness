// Template context fetcher. Copy to plugins/context/<name>/ (no leading "_").
// fetch() is what the model gets on demand (just in time); frontLoad() is what baseline mode puts up front.
import { defineContext } from '../../../core/sdk.js';

const DOCS: Record<string, string> = { example: 'One short paragraph the model can fetch when it needs it.' };

export default defineContext({
  name: 'example',
  description: 'Example documents by key',
  fetch(key) {
    return DOCS[key] ?? `unknown key "${key}"; known: ${Object.keys(DOCS).join(', ')}`;
  },
  frontLoad() {
    return Object.entries(DOCS)
      .map(([key, text]) => `## ${key}\n${text}`)
      .join('\n\n');
  },
});
