// Plugin registry (spec §5.4): discovers plugins/{tools,hooks,rules,context}/*/index.ts and
// drivers/*/index.ts, skips "_"-prefixed folders, applies plugins/registry.json, fails loudly with the path.
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import fg from 'fast-glob';
import { z } from 'zod';
import {
  validateDefinition,
  type ContextDefinition,
  type DriverDefinition,
  type HookDefinition,
  type PluginDefinition,
  type PluginKind,
  type RuleDefinition,
  type ToolDefinition,
} from './sdk.js';

export interface Loaded<T> {
  readonly def: T;
  readonly source: string; // root-relative path of the plugin's index.ts
}

export interface Registry {
  readonly root: string;
  readonly drivers: readonly Loaded<DriverDefinition>[];
  readonly tools: readonly Loaded<ToolDefinition>[];
  readonly hooks: readonly Loaded<HookDefinition>[]; // sorted by order, then id
  readonly rules: readonly Loaded<RuleDefinition>[];
  readonly contexts: readonly Loaded<ContextDefinition>[];
}

export class RegistryError extends Error {}

const RegistryFile = z.strictObject({
  disabled: z.array(z.string()).default([]),
  order: z.record(z.string(), z.number()).default({}),
  extraPaths: z.array(z.string()).default([]),
});

const FOLDER_KIND: Record<string, PluginKind> = { tools: 'tool', hooks: 'hook', rules: 'rule', context: 'context' };

function pluginId(def: PluginDefinition): string {
  return def.kind === 'tool' || def.kind === 'context' ? def.name : def.id;
}

function readRegistryFile(root: string): z.infer<typeof RegistryFile> {
  const path = join(root, 'plugins', 'registry.json');
  if (!existsSync(path)) return RegistryFile.parse({});
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new RegistryError(`plugins/registry.json: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const result = RegistryFile.safeParse(json);
  if (!result.success) {
    throw new RegistryError(`plugins/registry.json: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return result.data;
}

async function importDefinition(root: string, file: string, expected: PluginKind | undefined): Promise<PluginDefinition> {
  const source = relative(root, file);
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (error) {
    throw new RegistryError(`${source}: failed to load — ${error instanceof Error ? error.message : String(error)}`);
  }
  const exported = typeof mod === 'object' && mod !== null && 'default' in mod ? mod.default : undefined;
  try {
    return validateDefinition(exported, expected);
  } catch (error) {
    throw new RegistryError(`${source}: invalid plugin — ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function discover(root: string): Promise<{ file: string; expected: PluginKind | undefined }[]> {
  const patterns = ['plugins/tools/*/index.ts', 'plugins/hooks/*/index.ts', 'plugins/rules/*/index.ts', 'plugins/context/*/index.ts', 'drivers/*/index.ts'];
  const files = await fg(patterns, { cwd: root, onlyFiles: true });
  const found: { file: string; expected: PluginKind | undefined }[] = [];
  for (const rel of files.sort()) {
    const parts = rel.split('/');
    const folder = parts[0] === 'drivers' ? parts[1] : parts[2];
    if (folder === undefined || folder.startsWith('_')) continue;
    const expected = parts[0] === 'drivers' ? 'driver' : FOLDER_KIND[parts[1] ?? ''];
    found.push({ file: join(root, rel), expected });
  }
  return found;
}

/** Loads every plugin and driver under `root`. Throws RegistryError naming the offending path. */
export async function loadRegistry(root: string): Promise<Registry> {
  const absRoot = resolve(root);
  const config = readRegistryFile(absRoot);
  const entries = await discover(absRoot);
  for (const extra of config.extraPaths) {
    const file = resolve(absRoot, extra, 'index.ts');
    if (!existsSync(file)) throw new RegistryError(`plugins/registry.json: extraPaths entry "${extra}" has no index.ts`);
    entries.push({ file, expected: undefined });
  }

  const disabled = new Set(config.disabled);
  const seen = new Map<string, string>();
  const drivers: Loaded<DriverDefinition>[] = [];
  const tools: Loaded<ToolDefinition>[] = [];
  const hooks: Loaded<HookDefinition>[] = [];
  const rules: Loaded<RuleDefinition>[] = [];
  const contexts: Loaded<ContextDefinition>[] = [];

  for (const { file, expected } of entries) {
    const def = await importDefinition(absRoot, file, expected);
    const source = relative(absRoot, file);
    const key = `${def.kind}:${pluginId(def)}`;
    if (disabled.has(pluginId(def)) || disabled.has(key)) continue;
    const previous = seen.get(key);
    if (previous !== undefined) throw new RegistryError(`${source}: duplicate ${def.kind} "${pluginId(def)}" (also in ${previous})`);
    seen.set(key, source);
    switch (def.kind) {
      case 'driver':
        drivers.push({ def, source });
        break;
      case 'tool':
        tools.push({ def, source });
        break;
      case 'hook': {
        const order = config.order[def.id];
        hooks.push({ def: order === undefined ? def : { ...def, order }, source });
        break;
      }
      case 'rule':
        rules.push({ def, source });
        break;
      case 'context':
        contexts.push({ def, source });
        break;
    }
  }
  hooks.sort((a, b) => a.def.order - b.def.order || a.def.id.localeCompare(b.def.id));
  return { root: absRoot, drivers, tools, hooks, rules, contexts };
}

export function findDriver(registry: Registry, id: string): Loaded<DriverDefinition> {
  const found = registry.drivers.find((d) => d.def.id === id);
  if (found === undefined) {
    const ids = registry.drivers.map((d) => d.def.id).join(', ');
    throw new RegistryError(`unknown driver "${id}" — available: ${ids}`);
  }
  return found;
}
