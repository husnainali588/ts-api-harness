import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorCommand, main } from '../core/cli.js';
import { REPO_ROOT, captureIo, harnessCopy, removeDir, writeFile } from './helpers.js';

const run = promisify(execFile);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) removeDir(dir);
  delete process.env.HARNESS_FAKE_KEY;
});

describe('bin/harness.mjs', () => {
  it('`harness plugins` lists the scripted driver with its source path', async () => {
    const { stdout } = await run('node', [join(REPO_ROOT, 'bin', 'harness.mjs'), 'plugins'], {
      cwd: REPO_ROOT,
      env: { ...process.env, HARNESS_NO_DOTENV: '1' },
    });
    expect(stdout).toMatch(/drivers \(\d+\)/);
    expect(stdout).toMatch(/scripted\s+drivers\/scripted\/index\.ts/);
  });
});

describe('main', () => {
  it('prints usage and exits 2 for no or unknown commands', async () => {
    const io = captureIo();
    expect(await main([], io)).toBe(2);
    expect(await main(['frobnicate'], io)).toBe(2);
    expect(io.text()).toContain('unknown command "frobnicate"');
  });
});

describe('harness doctor', () => {
  it('prints env variable names, never values', async () => {
    const root = harnessCopy('doctor');
    dirs.push(root);
    writeFile(
      root,
      'drivers/fake/index.ts',
      `import { defineDriver } from '../../core/sdk.js';
export default defineDriver({ id: 'fake', description: 'fake', envKeys: ['HARNESS_FAKE_KEY', 'HARNESS_OTHER_KEY'], envVars: ['HARNESS_FAKE_MODEL'], create: () => { throw new Error('no'); } });
`,
    );
    process.env.HARNESS_FAKE_KEY = 'sk-super-secret-value-123';
    const io = captureIo();
    await doctorCommand([], io, root);
    const text = io.text();
    expect(text).toContain('driver fake');
    expect(text).toContain('ready — set: HARNESS_FAKE_KEY');
    expect(text).toContain('HARNESS_FAKE_MODEL not set');
    expect(text).toContain('driver scripted');
    expect(text).not.toContain('sk-super-secret-value-123');
  });

  it('reports a driver without a key', async () => {
    const root = harnessCopy('doctor');
    dirs.push(root);
    writeFile(
      root,
      'drivers/fake/index.ts',
      `import { defineDriver } from '../../core/sdk.js';
export default defineDriver({ id: 'fake', description: 'fake', envKeys: ['HARNESS_FAKE_KEY'], create: () => { throw new Error('no'); } });
`,
    );
    const io = captureIo();
    await doctorCommand([], io, root);
    expect(io.text()).toContain('no key — set one of: HARNESS_FAKE_KEY');
  });
});
