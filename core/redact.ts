// Everything written to runs/, reports/ and tokens/ passes through redact() (spec §1.5).
import { isSecretName } from './exec.js';

/** Common key formats. Also used by the ship step's staged-diff scan. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-or-[A-Za-z0-9_-]{16,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9]{32,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

/** Current values of env vars whose names look secret (≥ 8 chars, so short values don't redact everything). */
export function secretEnvValues(env: NodeJS.ProcessEnv = process.env): { name: string; value: string }[] {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1].length >= 8 && isSecretName(entry[0]))
    .map(([name, value]) => ({ name, value }));
}

export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const { name, value } of secretEnvValues(env)) out = out.split(value).join(`[REDACTED:${name}]`);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  return out;
}

/** Secret findings in a text: pattern matches and literal env secret values. Names only, never the value. */
export function findSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const found: string[] = [];
  for (const { name, value } of secretEnvValues(env)) if (text.includes(value)) found.push(`value of ${name}`);
  for (const pattern of SECRET_PATTERNS) {
    if (new RegExp(pattern.source).test(text)) found.push(`pattern ${pattern.source.slice(0, 12)}…`);
  }
  return found;
}
