// G4 — the harness ships, the agent never does (spec §5.8, §6 G4). Preconditions, protected-branch refusal,
// selective staging (never `git add -A`), staged-diff secret scan, commit with the gate summary, push of the feature
// branch only, pull request via gh. Never --force, never --no-verify.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { exec } from './exec.js';
import { findSecrets, redact } from './redact.js';

const Summary = z.looseObject({
  runId: z.string(),
  status: z.string(),
  reason: z.string(),
  baseline: z.boolean(),
  branch: z.string(),
  worktree: z.string(),
  apiRoot: z.string(),
  task: z.looseObject({ path: z.string(), mode: z.string() }),
  driver: z.string(),
  servedBy: z.array(z.string()),
  transports: z.array(z.string()),
  tokens: z.looseObject({ totalInputTokens: z.number(), totalOutputTokens: z.number(), turns: z.number(), source: z.string() }),
  gate: z.looseObject({ green: z.boolean(), lines: z.array(z.string()), unproven: z.array(z.string()) }).nullable(),
  honesty: z.looseObject({ proven: z.array(z.string()), unproven: z.array(z.string()), outOfReach: z.array(z.string()) }),
  writtenFiles: z.array(z.string()).default([]),
  contractChanges: z.object({ breaking: z.array(z.string()), additive: z.array(z.string()) }).nullable().default(null),
  prUrl: z.string().nullable(),
});
export type ShipSummary = z.infer<typeof Summary>;

export interface ShipResult {
  status: 'shipped' | 'refused' | 'unproven';
  reason: string;
  branch?: string;
  commit?: string;
  prUrl?: string;
}

export type PrCreator = (pr: { cwd: string; base: string; head: string; title: string; bodyFile: string }) => Promise<{ url: string } | { unproven: string }>;

const PROTECTED = [/^main$/, /^master$/, /^develop$/, /^trunk$/, /^release\//, /^prod/];

async function git(args: string[], cwd: string, keepSecrets = false) {
  return exec('git', args, { cwd, timeoutMs: 180_000, keepSecrets });
}

/** Default PR creator: gh. Missing or unauthenticated gh → unproven, no fallbacks. */
export const ghCreatePr: PrCreator = async ({ cwd, base, head, title, bodyFile }) => {
  const auth = await exec('gh', ['auth', 'status'], { cwd, keepSecrets: true });
  if (auth.code !== 0) return { unproven: 'gh is missing or not authenticated' };
  const res = await exec('gh', ['pr', 'create', '--base', base, '--head', head, '--title', title, '--body-file', bodyFile], { cwd, keepSecrets: true, timeoutMs: 120_000 });
  const url = res.stdout.split('\n').find((l) => /^https?:\/\//.test(l.trim()))?.trim();
  return res.code === 0 && url !== undefined ? { url } : { unproven: `gh pr create failed: ${res.stderr.split('\n')[0] ?? ''}` };
};

export async function remoteDefaultBranch(cwd: string, remote: string): Promise<string> {
  const res = await git(['ls-remote', '--symref', remote, 'HEAD'], cwd, true);
  const m = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(res.stdout);
  return m?.[1] ?? 'main';
}

export function prBody(s: ShipSummary, standards: string): string {
  const summaryBlock = standards.split('\n').slice(standards.split('\n').findIndex((l) => l.startsWith('─')) + 1).join('\n');
  return [
    `## ${s.task.mode === 'brownfield' ? 'Change to an existing API' : 'New API'} — ${s.task.path}`,
    `Shipped by the harness after every gate was green. Run \`${s.runId}\`, driver \`${s.driver}\` (${s.transports.join(', ')}; served by ${s.servedBy.join(', ')}).`,
    '',
    '### Finish gate',
    '```',
    ...(s.gate?.lines ?? []),
    '```',
    '### Standards',
    '```',
    summaryBlock.trim(),
    '```',
    '### Tokens',
    `${s.tokens.totalInputTokens} input / ${s.tokens.totalOutputTokens} output tokens over ${s.tokens.turns} turns (${s.tokens.source === 'provider' ? 'provider usage' : 'ESTIMATE — scripted/replay driver, not evidence'}).`,
    ...(s.contractChanges !== null ? ['', '### Contract', `Breaking: ${s.contractChanges.breaking.length === 0 ? 'none' : s.contractChanges.breaking.join('; ')}`, `Additive: ${s.contractChanges.additive.length === 0 ? 'none' : s.contractChanges.additive.map((a) => `\n- ${a}`).join('')}`] : []),
    '',
    '### Honesty',
    `- Proven: ${s.honesty.proven.length === 0 ? 'nothing beyond the gate lines' : 'tests, red→green continuity, strict tsc, standards checks and the problem probe as listed above'}.`,
    `- Unproven: ${s.honesty.unproven.length === 0 ? 'none' : s.honesty.unproven.join('; ')}.`,
    `- Out of reach (a human must verify): ${s.honesty.outOfReach.join(', ')}.`,
    `- Evidence: \`runs/${s.runId}/\`, \`reports/${s.runId}/\`.`,
  ].join('\n');
}

export async function ship(opts: { repoRoot: string; runId: string; remote?: string; createPr?: PrCreator; log?: (line: string) => void }): Promise<ShipResult> {
  const remote = opts.remote ?? 'origin';
  const log = opts.log ?? (() => {});
  const runDir = join(opts.repoRoot, 'runs', opts.runId);
  const summaryPath = join(runDir, 'summary.json');
  if (!existsSync(summaryPath)) return { status: 'refused', reason: `run ${opts.runId} not found` };
  const s = Summary.parse(JSON.parse(readFileSync(summaryPath, 'utf8')));

  // Preconditions (G4).
  if (s.baseline) return { status: 'refused', reason: 'baseline runs never ship' };
  if (s.status !== 'green' || s.gate?.green !== true) return { status: 'refused', reason: `the run is not green (${s.status}: ${s.reason})` };
  const unproven = [...(s.gate?.unproven ?? []), ...s.honesty.unproven.filter((u) => !u.startsWith('token numbers are estimates'))];
  if (unproven.length > 0) return { status: 'refused', reason: `unproven: ${unproven.join('; ')}` };
  const worktree = join(opts.repoRoot, s.worktree);
  if (!existsSync(worktree)) return { status: 'refused', reason: `worktree ${s.worktree} is gone` };
  const current = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], worktree)).stdout.trim();
  if (current !== s.branch) return { status: 'refused', reason: `worktree is on ${current}, expected ${s.branch}` };
  const defaultBranch = await remoteDefaultBranch(worktree, remote);
  if (PROTECTED.some((re) => re.test(s.branch)) || s.branch === defaultBranch) return { status: 'refused', reason: `branch ${s.branch} is protected` };

  // Evidence into the branch, then the PR body.
  const evidence = [`runs/${s.runId}`, `reports/${s.runId}`, `tokens/${s.runId}.json`].filter((p) => existsSync(join(opts.repoRoot, p)));
  const standardsPath = join(opts.repoRoot, 'reports', s.runId, 'standards.txt');
  const body = prBody(s, existsSync(standardsPath) ? readFileSync(standardsPath, 'utf8') : '(no standards report)');
  writeFileSync(join(runDir, 'pr.md'), redact(body));
  for (const p of evidence) cpSync(join(opts.repoRoot, p), join(worktree, p), { recursive: true });

  // Stage only the run's output/scope and its evidence — never `git add -A`.
  const output = s.task.mode === 'greenfield' ? [s.apiRoot] : s.writtenFiles.map((f) => `${s.apiRoot}/${f}`);
  // Installed packages never ship, whatever the repo's .gitignore says (workspaces symlink node_modules).
  const add = await git(['add', '--', ...output, ...evidence, ':(exclude,glob)**/node_modules', ':(exclude,glob)**/node_modules/**'], worktree);
  if (add.code !== 0) return { status: 'refused', reason: `git add failed: ${add.stderr.trim()}` };
  const diff = await git(['diff', '--cached'], worktree);
  const secrets = findSecrets(diff.stdout);
  if (secrets.length > 0) {
    await git(['reset', '-q'], worktree);
    return { status: 'refused', reason: `secret scan hit in the staged diff: ${secrets.join(', ')}` };
  }
  const gateSummary = (s.gate?.lines ?? []).filter((l) => /^\S/.test(l)).join('\n');
  const message = `feat(${s.task.mode}): ${s.task.path} via the harness (run ${s.runId})\n\nFinish gate:\n${gateSummary}\n\nEvidence: runs/${s.runId}/`;
  const commit = await git(['commit', '-q', '-m', message], worktree);
  if (commit.code !== 0) return { status: 'refused', reason: `git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}` };
  const sha = (await git(['rev-parse', 'HEAD'], worktree)).stdout.trim();
  log(`ship: committed ${sha.slice(0, 7)} on ${s.branch}`);

  const push = await git(['push', '-u', remote, s.branch], worktree, true);
  if (push.code !== 0) return { status: 'unproven', reason: `git push failed: ${push.stderr.split('\n')[0] ?? ''}`, branch: s.branch, commit: sha };
  log(`ship: pushed ${s.branch} to ${remote}`);

  const pr = await (opts.createPr ?? ghCreatePr)({ cwd: worktree, base: defaultBranch, head: s.branch, title: `${s.task.mode === 'brownfield' ? 'Change' : 'New API'}: ${s.task.path} (harness run ${s.runId})`, bodyFile: join(runDir, 'pr.md') });
  if ('unproven' in pr) return { status: 'unproven', reason: pr.unproven, branch: s.branch, commit: sha };
  const updated = { ...JSON.parse(readFileSync(summaryPath, 'utf8')), prUrl: pr.url, shipped: { branch: s.branch, commit: sha } };
  writeFileSync(summaryPath, `${redact(JSON.stringify(updated, null, 2))}\n`);
  log(`ship: pull request ${pr.url}`);
  return { status: 'shipped', reason: 'all gates green', branch: s.branch, commit: sha, prUrl: pr.url };
}
