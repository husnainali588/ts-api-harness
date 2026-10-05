// Task sections, fetched with get_task(section); baseline mode front-loads the task file verbatim.
import { defineContext, renderTaskBrief } from '../../../core/sdk.js';

export default defineContext({
  name: 'task',
  description: 'The task: brief, fields, behaviours or the file verbatim',
  fetch(key, ctx) {
    const t = ctx.task;
    switch (key) {
      case 'fields':
        return t.fields.map((f) => `${f.name}: ${f.type}${f.required ? '' : ' (optional)'}${f.unique ? ' (unique)' : ''}${f.generated ? ' (server-generated)' : ''} ${JSON.stringify(f.constraints)}`).join('\n');
      case 'behaviours':
        return t.behaviours.map((b) => `- ${b}`).join('\n');
      case 'verbatim':
        return t.text;
      default:
        return renderTaskBrief(t);
    }
  },
  frontLoad(ctx) {
    return `# Task file ${ctx.task.path}\n${ctx.task.text}`;
  },
});
