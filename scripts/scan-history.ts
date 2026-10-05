// Scans the full git history (every commit's patch, all refs) for key formats and for the literal values of any
// secret-named env vars that are set. Prints names/locations only, never a value. Exit 1 on any hit.
import { execFileSync } from 'node:child_process';
import { SECRET_PATTERNS, secretEnvValues } from '../core/redact.js';

const log = execFileSync('git', ['log', '--all', '-p', '--no-color', '--format=commit %H'], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
const values = secretEnvValues();
const hits: string[] = [];
let commit = '';
for (const line of log.split('\n')) {
  if (line.startsWith('commit ')) {
    commit = line.slice(7, 14);
    continue;
  }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  for (const p of SECRET_PATTERNS) if (new RegExp(p.source).test(line)) hits.push(`${commit}: pattern ${p.source.slice(0, 14)}…`);
  for (const { name, value } of values) if (line.includes(value)) hits.push(`${commit}: value of ${name}`);
}
if (hits.length > 0) {
  console.log(`secret scan: ${hits.length} hit(s)\n${[...new Set(hits)].join('\n')}`);
  process.exit(1);
}
console.log(`secret scan: clean (${SECRET_PATTERNS.length} key formats, ${values.length} env secret values, all refs)`);
