import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';

export default defineTool({
  name: 'propose_scope',
  description: 'Existing APIs: declare the files you will change (incl. tests and new files) before any write.',
  input: z.object({ files: z.array(z.string().min(1)).min(1), reason: z.string().min(1) }),
  async run(input, ctx) {
    return ctx.services.proposeScope(input.files, input.reason);
  },
});
