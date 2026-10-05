// Regression from the paid Haiku runs: imports of packages the API does not have (uuid) are blocked at write time;
// the real exported helper names are available on demand.
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportsDoc } from '../plugins/context/standards/index.js';
import { importedPackages, packageOf } from '../plugins/hooks/import-guard/index.js';
import { REPO_ROOT, call, makeRepo, readEvents, removeDir, scriptedRun } from './helpers.js';

let repo: string;
beforeAll(() => {
  repo = makeRepo('imports');
});
afterAll(() => removeDir(repo));

describe('import-guard', () => {
  it('extracts package names from bare specifiers only', () => {
    expect(packageOf('uuid')).toBe('uuid');
    expect(packageOf('@scope/pkg/sub')).toBe('@scope/pkg');
    expect(packageOf('./x.js')).toBeUndefined();
    expect(packageOf('node:crypto')).toBeUndefined();
    const code = `import { v4 } from 'uuid';\nimport type { Express } from 'express';\nimport { randomUUID } from 'node:crypto';\nimport fs from 'fs';\nexport * from '../x.js';\nconst m = await import('left-pad');\nconst r = require('lodash/fp');\nimport 'side-effect-pkg';\n`;
    expect(importedPackages(code).sort()).toEqual(['express', 'left-pad', 'lodash', 'side-effect-pkg', 'uuid']);
  });

  it('blocks a write that imports a package the API does not have, listing installed ones', async () => {
    const s = await scriptedRun(repo, [{ toolCalls: [call('write_file', { path: 'test/ids.test.ts', content: "import { v4 } from 'uuid';\nimport { expect, it } from 'vitest';\nit('x', () => expect(v4()).toBeTruthy());\n" })] }], { maxTurns: 1 });
    const d = readEvents(repo, s.runId).find((e) => e.hook === 'import-guard');
    expect(d).toMatchObject({ decision: 'block', exit: 2 });
    expect(String(d?.reason)).toMatch(/"uuid", which is not installed\. Installed: express, zod, @types\/express/);
    expect(String(d?.fix)).toMatch(/randomUUID from "node:crypto"/);
  });

  it('passes installed packages, builtins and relative imports', async () => {
    const content = "import request from 'supertest';\nimport { randomUUID } from 'node:crypto';\nimport { expect, it } from 'vitest';\nimport { createApp } from '../src/app.js';\nit('x', () => expect(randomUUID()).toBeTruthy());\nvoid request; void createApp;\n";
    const s = await scriptedRun(repo, [{ toolCalls: [call('write_file', { path: 'test/ok.test.ts', content })] }], { maxTurns: 1 });
    expect(readEvents(repo, s.runId).find((e) => e.hook === 'import-guard')).toMatchObject({ decision: 'pass' });
  });
});

describe('get_standard exports', () => {
  it('lists the real exported helpers of the template', () => {
    const doc = exportsDoc(join(REPO_ROOT, 'templates/api'));
    for (const name of ['pageOf', 'ListQuery', 'MemoryStore', 'defineRoute', 'NoContent', 'NotFound', 'Conflict', 'createApp']) expect(doc).toContain(`  ${name} (`);
    expect(doc).not.toContain('PaginatedList');
  });
});
