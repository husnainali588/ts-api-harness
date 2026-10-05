// Brownfield flow (spec §8): green baseline, before-snapshots (contract, findings, source↔test map), scope proposals
// limited to what the target resource reaches, and the ratchet + contract gate at finish.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import fg from 'fast-glob';
import { runChecks, type CheckReport } from './checks.js';
import { snapshotContract, diffContracts } from './contract.js';
import type { Contract } from './contract-runner.js';
import type { GateResult, RunContext } from './loop.js';
import type { ToolOutput } from './sdk.js';
import { buildImportMap, importCandidates, runTests } from './tests.js';

export interface Finding {
  rule: string;
  file: string;
  message: string;
}

export interface BrownfieldBefore {
  contract: Contract;
  findings: Finding[];
}

const runDir = (run: RunContext) => join(run.repoRoot, '.harness', 'runs', run.runId);

/** Findings without line numbers, so moving code does not count as a new finding. */
export function findingsOf(report: CheckReport): Finding[] {
  return report.rules.flatMap((r) => r.files.flatMap((f) => f.failures.map((x) => ({ rule: r.id, file: f.file, message: x.message }))));
}

/** Runs before the model's first turn. Returns a reason when the run must stop (baseline red → unproven). */
export async function snapshotBefore(run: RunContext): Promise<{ before: BrownfieldBefore } | { stop: string }> {
  const dir = runDir(run);
  mkdirSync(dir, { recursive: true });
  const tests = await runTests({ apiRoot: run.workspace.apiRoot, runDir: dir, state: run.state, turn: 0, saveRaw: (l, c) => run.evidence.saveRaw(l, c) });
  const failing = run.state.observations.filter((o) => o.status === 'failed');
  if (tests.summary.startsWith('UNPROVEN') || failing.length > 0) return { stop: `baseline red: ${tests.summary}` };
  // The existing suite was green before the model touched anything: nothing from the baseline counts as red.
  run.state.redCases.length = 0;
  run.state.lastTest = `baseline ${tests.summary}`;

  const contract = await snapshotContract(run.workspace.apiRoot, dir);
  if ('error' in contract) return { stop: `cannot snapshot the contract: ${contract.error}` };
  const report = await runChecks({ apiRoot: run.workspace.apiRoot, registry: run.registry, runId: `${run.runId}-before`, reportsRoot: dir, task: run.task });
  const before: BrownfieldBefore = { contract, findings: findingsOf(report).filter((f) => f.rule !== 'task-coverage') };
  writeFileSync(join(dir, 'contract.before.json'), `${JSON.stringify(contract, null, 2)}\n`);
  writeFileSync(join(dir, 'findings.before.json'), `${JSON.stringify(before.findings, null, 2)}\n`);
  writeFileSync(join(dir, 'map.json'), `${JSON.stringify(Object.fromEntries(buildImportMap(run.workspace.apiRoot)), null, 2)}\n`);
  return { before };
}

/** Files reachable from the task's resource: seeds (paths naming it) plus their import closure, plus mapped tests. */
export function reachableFiles(apiRoot: string, resource: string): { files: Set<string>; dirs: Set<string> } {
  const all = fg.sync(['src/**/*.ts', 'test/**/*.ts'], { cwd: apiRoot, ignore: ['**/node_modules/**'] });
  const singular = resource.replace(/s$/, '');
  const names = new RegExp(`(^|/)(${resource}|${singular})([/.-]|$)`, 'i');
  const seeds = all.filter((f) => f.startsWith('src/') && names.test(f));
  const files = new Set<string>(seeds);
  const queue = [...seeds];
  while (queue.length > 0) {
    const file = queue.pop() ?? '';
    const text = existsSync(join(apiRoot, file)) ? readFileSync(join(apiRoot, file), 'utf8') : '';
    for (const m of text.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      for (const cand of importCandidates(file, m[1] ?? '')) {
        if (all.includes(cand) && !files.has(cand)) {
          files.add(cand);
          queue.push(cand);
        }
      }
    }
  }
  for (const [test, imports] of buildImportMap(apiRoot)) if (imports.some((i) => files.has(i)) || names.test(test)) files.add(test);
  const dirs = new Set([...files].filter((f) => names.test(f)).map((f) => dirname(f)));
  return { files, dirs };
}

export function proposeScope(run: RunContext, files: string[], reason: string): ToolOutput {
  if (run.task.mode !== 'brownfield') return { summary: 'No scope needed: this is a greenfield task; write freely inside the API root.' };
  const { files: reachable, dirs } = reachableFiles(run.workspace.apiRoot, run.task.resource);
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const raw of files) {
    const file = raw.replace(/^\.\//, '');
    const isNewBeside = !existsSync(join(run.workspace.apiRoot, file)) && dirs.has(dirname(file));
    if (reachable.has(file) || isNewBeside) accepted.push(file);
    else rejected.push(file);
  }
  run.state.acceptedScope = [...new Set([...(run.state.acceptedScope ?? []), ...accepted])];
  run.evidence.event({ type: 'scope', turn: run.turn, accepted, rejected, reason });
  const scope = `Accepted scope now: ${run.state.acceptedScope.join(', ') || 'none'}.`;
  if (rejected.length === 0) return { summary: `Scope accepted (${accepted.length} files). ${scope}` };
  return {
    summary: `Rejected (not reachable from ${run.task.resource} in the import graph): ${rejected.join(', ')}. Allowed: ${[...reachable].sort().join(', ')} or new files in ${[...dirs].sort().join(', ')}. ${scope}`,
    isError: true,
  };
}

/** Finish additions: ratchet (touched files clean, no new findings anywhere) and contract (no breaking change). */
export function brownfieldGate(before: BrownfieldBefore) {
  return async (run: RunContext, report: CheckReport): Promise<GateResult> => {
    const lines: string[] = [];
    let green = true;
    const after = findingsOf(report).filter((f) => f.rule !== 'task-coverage');
    const key = (f: Finding) => `${f.rule}|${f.file}|${f.message}`;
    const known = new Set(before.findings.map(key));
    const fresh = after.filter((f) => !known.has(key(f)));
    const touched = after.filter((f) => run.state.writtenFiles.includes(f.file));
    if (fresh.length > 0 || touched.length > 0) {
      green = false;
      lines.push(`ratchet      FAIL      ${fresh.length} new finding(s), ${touched.length} in touched files`);
      for (const f of [...fresh, ...touched].slice(0, 8)) lines.push(`  ${f.rule} ${f.file}: ${f.message}`);
    } else {
      lines.push(`ratchet      pass      no new findings (${before.findings.length} before), touched files clean`);
    }
    const contract = await snapshotContract(run.workspace.apiRoot, runDir(run));
    if ('error' in contract) {
      return { green: false, lines: [...lines, `contract     UNPROVEN  ${contract.error}`], unproven: [`contract: ${contract.error}`] };
    }
    writeFileSync(join(runDir(run), 'contract.after.json'), `${JSON.stringify(contract, null, 2)}\n`);
    const diff = diffContracts(before.contract, contract);
    run.state.contractChanges = diff;
    if (diff.breaking.length > 0) {
      green = false;
      lines.push(`contract     FAIL      ${diff.breaking.length} breaking change(s)`);
      for (const b of diff.breaking.slice(0, 8)) lines.push(`  ${b}`);
    } else {
      lines.push(`contract     pass      no breaking change; additive: ${diff.additive.length === 0 ? 'none' : diff.additive.join('; ')}`);
    }
    return { green, lines, unproven: [] };
  };
}
