import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RegistryError, findDriver, loadRegistry } from '../core/registry.js';
import { PluginDefinitionError, defineTool, validateDefinition } from '../core/sdk.js';
import { REPO_ROOT, harnessCopy, removeDir, writeFile } from './helpers.js';

const TOOL = (name: string) => `import { z } from 'zod';
import { defineTool } from '../../../core/sdk.js';
export default defineTool({
  name: '${name}',
  description: 'test tool ${name}',
  input: z.object({}),
  run: () => ({ summary: 'ok' }),
});
`;

const HOOK = (id: string, order: number) => `import { defineHook } from '../../../core/sdk.js';
export default defineHook({ id: '${id}', phase: 'pre', order: ${order}, matches: () => true, run: () => ({ decision: 'pass' }) });
`;

const dirs: string[] = [];
function copy(): string {
  const dir = harnessCopy('registry');
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
});

describe('loadRegistry on the repo', () => {
  it('discovers the scripted driver and ignores _template folders', async () => {
    const registry = await loadRegistry(REPO_ROOT);
    expect(registry.drivers.map((d) => d.def.id)).toContain('scripted');
    expect(findDriver(registry, 'scripted').source).toBe('drivers/scripted/index.ts');
    const sources = [...registry.drivers, ...registry.tools, ...registry.hooks, ...registry.rules, ...registry.contexts].map((p) => p.source);
    expect(sources.some((s) => s.includes('_template'))).toBe(false);
  });

  it('names the available drivers for an unknown id', async () => {
    const registry = await loadRegistry(REPO_ROOT);
    expect(() => findDriver(registry, 'nope')).toThrow(/unknown driver "nope" — available: .*scripted/);
  });
});

describe('loadRegistry on a temp copy', () => {
  it('discovers a plugin dropped into plugins/tools', async () => {
    const root = copy();
    writeFile(root, 'plugins/tools/hello_tool/index.ts', TOOL('hello_tool'));
    const registry = await loadRegistry(root);
    const tool = registry.tools.find((t) => t.def.name === 'hello_tool');
    expect(tool?.source).toBe('plugins/tools/hello_tool/index.ts');
  });

  it('ignores "_"-prefixed folders even when they are broken', async () => {
    const root = copy();
    writeFile(root, 'plugins/tools/_wip/index.ts', 'this is not typescript {');
    const registry = await loadRegistry(root);
    expect(registry.tools.some((t) => t.source.includes('_wip'))).toBe(false);
  });

  it('fails loudly with the path of a plugin whose export is not a definition', async () => {
    const root = copy();
    writeFile(root, 'plugins/rules/broken/index.ts', 'export default { id: "broken" };\n');
    await expect(loadRegistry(root)).rejects.toThrow(/plugins\/rules\/broken\/index\.ts: invalid plugin/);
  });

  it('fails loudly with the path of a plugin that does not load', async () => {
    const root = copy();
    writeFile(root, 'plugins/hooks/syntax/index.ts', 'export default {{{;\n');
    await expect(loadRegistry(root)).rejects.toThrow(/plugins\/hooks\/syntax\/index\.ts: failed to load/);
  });

  it('rejects a definition of the wrong kind for its folder', async () => {
    const root = copy();
    writeFile(root, 'plugins/rules/a_tool/index.ts', TOOL('a_tool'));
    await expect(loadRegistry(root)).rejects.toThrow(/plugins\/rules\/a_tool\/index\.ts: invalid plugin — expected a rule definition, got a tool/);
  });

  it('rejects duplicate names', async () => {
    const root = copy();
    writeFile(root, 'plugins/tools/one/index.ts', TOOL('same_name'));
    writeFile(root, 'plugins/tools/two/index.ts', TOOL('same_name'));
    await expect(loadRegistry(root)).rejects.toThrow(/duplicate tool "same_name"/);
  });

  it('applies plugins/registry.json: disabled, order and extraPaths', async () => {
    const root = copy();
    writeFile(root, 'plugins/tools/off_tool/index.ts', TOOL('off_tool'));
    writeFile(root, 'plugins/hooks/late/index.ts', HOOK('late', 50));
    writeFile(root, 'plugins/hooks/early/index.ts', HOOK('early', 10));
    writeFile(root, 'extra/my_tool/index.ts', TOOL('my_tool').replace('../../../core/sdk.js', '../../core/sdk.js'));
    writeFile(
      root,
      'plugins/registry.json',
      JSON.stringify({ disabled: ['off_tool'], order: { late: 1 }, extraPaths: ['extra/my_tool'] }),
    );
    const registry = await loadRegistry(root);
    expect(registry.tools.map((t) => t.def.name)).not.toContain('off_tool');
    expect(registry.tools.find((t) => t.def.name === 'my_tool')?.source).toBe('extra/my_tool/index.ts');
    expect(registry.hooks.map((h) => h.def.id).filter((id) => id === 'late' || id === 'early')).toEqual(['late', 'early']);
    expect(registry.hooks.find((h) => h.def.id === 'late')?.def.order).toBe(1);
  });

  it('rejects an invalid registry.json', async () => {
    const root = copy();
    writeFile(root, 'plugins/registry.json', JSON.stringify({ disabld: [] }));
    await expect(loadRegistry(root)).rejects.toThrow(/plugins\/registry\.json/);
  });
});

describe('define* validation', () => {
  it('rejects a tool name that is not ^[a-z0-9_]{1,64}$', () => {
    expect(() => defineTool({ name: 'Bad-Name', description: 'x', input: z.object({}), run: () => ({ summary: '' }) })).toThrow(
      PluginDefinitionError,
    );
  });

  it('rejects a rule with neither check nor checkProject', () => {
    expect(() => validateDefinition({ kind: 'rule', id: 'r', description: 'd', unit: 'u', files: ['src/**/*.ts'], required: true })).toThrow(
      /exactly one of check or checkProject/,
    );
  });

  it('rejects values that are not definitions', () => {
    expect(() => validateDefinition(42)).toThrow(/not a plugin definition/);
  });
});

describe('RegistryError', () => {
  it('is an Error', () => {
    expect(new RegistryError('x')).toBeInstanceOf(Error);
  });
});
