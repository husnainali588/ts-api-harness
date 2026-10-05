#!/usr/bin/env node
// npm run setup — one command: check Node, install, create .env from .env.example if missing, run self-tests.
// Plain JS with no dependencies so it runs before `npm install`.
import { execFileSync } from 'node:child_process';
import { constants, copyFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args, cwd = root) => execFileSync(npm, args, { cwd, stdio: 'inherit' });

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`Node >= 22 required, found ${process.versions.node}`);
  process.exit(1);
}

console.log('› installing harness dependencies');
run(['install', '--no-audit', '--no-fund']);

for (const dir of ['templates/api', 'fixtures/sample-api']) {
  if (existsSync(join(root, dir, 'package.json'))) {
    console.log(`› installing ${dir} dependencies`);
    run(['ci', '--no-audit', '--no-fund', '--ignore-scripts'], join(root, dir));
  }
}

const env = join(root, '.env');
if (existsSync(env)) {
  console.log('› .env exists (left untouched)');
} else {
  copyFileSync(join(root, '.env.example'), env, constants.COPYFILE_EXCL);
  console.log('› created .env from .env.example — add a key there (see README); never commit it');
}

console.log('› running self-tests (scripted driver, no model calls)');
run(['test']);
console.log('\nsetup complete. Next: npx harness doctor');
