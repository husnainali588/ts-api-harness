// Template hook. Copy this folder to plugins/hooks/<your-hook>/ (no leading "_").
// pre hooks run before a tool call and may block it; post hooks run after it and may record notes.
import { defineHook } from '../../../core/sdk.js';

export default defineHook({
  id: 'example-hook',
  phase: 'pre',
  order: 100, // lower runs first
  matches: (call) => call.name === 'write_file',
  run(_call, ctx) {
    if (typeof ctx.input === 'object' && ctx.input !== null && 'path' in ctx.input && ctx.input.path === 'forbidden.ts') {
      // Block feedback always states the next action.
      return { decision: 'block', reason: 'forbidden.ts may not be written', fix: 'Write the code to another file, then retry.' };
    }
    return { decision: 'pass' };
  },
});
