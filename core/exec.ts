// Subprocesses: execFile with an argument array, never a shell, never a string-built command (spec §1.3).
import { execFile } from 'node:child_process';
import type { Exec, ExecResult } from './sdk.js';

const SECRET_NAME = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS)$|API_KEY/;

/** process.env without anything that looks like a secret, so model-written code run by the harness can't read keys. */
export function scrubbedEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !SECRET_NAME.test(name)) env[name] = value;
  }
  return { ...env, ...extra };
}

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

interface ExecOptions {
  cwd?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
  /** Keep secret env vars (only for harness-owned steps such as git push / gh). Default false. */
  keepSecrets?: boolean;
}

export function exec(file: string, args: readonly string[], opts: ExecOptions = {}): Promise<ExecResult> {
  const env = opts.keepSecrets === true ? { ...process.env, ...opts.env } : scrubbedEnv(opts.env);
  return new Promise((resolvePromise) => {
    execFile(
      file,
      [...args],
      { cwd: opts.cwd, env, timeout: opts.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024, shell: false, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise({ code: 0, stdout, stderr, timedOut: false });
          return;
        }
        const timedOut = error.killed === true && error.signal === 'SIGTERM';
        const code = typeof error.code === 'number' ? error.code : 127;
        resolvePromise({ code, stdout, stderr: stderr === '' ? error.message : stderr, timedOut });
      },
    );
  });
}

export const execTool: Exec = (file, args, opts) => exec(file, args, opts ?? {});
