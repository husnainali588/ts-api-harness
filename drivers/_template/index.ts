// Template driver. Copy to drivers/<id>/ (no leading "_"). Everything vendor-specific stays inside this folder:
// message/role translation, tool-schema shape, retries, model id (from env), usage normalisation.
import type { Driver, TurnRequest, TurnResponse } from '../../core/driver.js';
import { defineDriver } from '../../core/sdk.js';

class EchoDriver implements Driver {
  readonly id = 'echo';
  async turn(req: TurnRequest): Promise<TurnResponse> {
    const last = req.messages.at(-1);
    const text = last?.role === 'user' ? last.content : '';
    return {
      text,
      toolCalls: [],
      stop: 'end',
      // Input tokens = the full context processed this turn, cached + uncached, from the provider's usage fields.
      usage: { inputTokens: 0, outputTokens: 0, source: 'estimate' },
      transport: 'local',
      model: 'echo',
    };
  }
}

export default defineDriver({
  id: 'echo',
  description: 'Template driver that echoes the last user message',
  envKeys: [], // names of env vars that authenticate this driver; any one is enough
  envVars: [], // optional env var names it reads (model ids, base URLs)
  create: () => new EchoDriver(),
});
