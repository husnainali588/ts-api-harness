// G3 — the finish gate (spec §6). Only this ends a run green: full suite green via the harness runner, every test
// case ever seen red still exists and passes, strict tsc clean and the standards checks at 100% with nothing unproven.
import { compactReport, runChecks, type CheckReport } from './checks.js';
import type { GateResult, RunContext } from './loop.js';
import type { TestCaseObservation } from './sdk.js';
import { LOAD_CASE, runTests } from './tests.js';
import { join } from 'node:path';

export type ExtraGate = (run: RunContext, report: CheckReport) => Promise<GateResult>;

/** Continuity: every red case is still there, not skipped, and passing now. */
export function continuity(red: readonly { file: string; name: string; turn: number }[], latest: readonly TestCaseObservation[]): string[] {
  const failures: string[] = [];
  for (const c of red) {
    if (c.name === LOAD_CASE) {
      const cases = latest.filter((o) => o.file === c.file);
      if (cases.length === 0) failures.push(`${c.file}: was red at turn ${c.turn}, now the file is gone`);
      else if (!cases.some((o) => o.status === 'passed')) failures.push(`${c.file}: was red at turn ${c.turn}, now has no passing test`);
      else if (cases.some((o) => o.status !== 'passed')) failures.push(`${c.file}: was red at turn ${c.turn}, now has failing or skipped tests`);
      continue;
    }
    const now = latest.find((o) => o.file === c.file && o.name === c.name);
    if (now === undefined) failures.push(`${c.file} › ${c.name}: was red at turn ${c.turn}, now missing (deleted or renamed)`);
    else if (now.status === 'skipped' || now.status === 'todo') failures.push(`${c.file} › ${c.name}: was red at turn ${c.turn}, now ${now.status}`);
    else if (now.status !== 'passed') failures.push(`${c.file} › ${c.name}: was red at turn ${c.turn}, still failing`);
  }
  return failures;
}

export async function finishGate(run: RunContext, extra: ExtraGate[] = []): Promise<GateResult> {
  const lines: string[] = [];
  const unproven: string[] = [];
  let green = true;

  const tests = await runTests({
    apiRoot: run.workspace.apiRoot,
    runDir: join(run.repoRoot, '.harness', 'runs', run.runId),
    state: run.state,
    turn: run.turn,
    saveRaw: (label, content) => run.evidence.saveRaw(label, content),
  });
  const testsUnproven = tests.summary.startsWith('UNPROVEN');
  const failing = run.state.observations.filter((o) => o.status === 'failed').length;
  if (testsUnproven) {
    green = false;
    unproven.push(`tests: ${tests.summary}`);
    lines.push(`tests        UNPROVEN  ${tests.summary}`);
  } else if (failing > 0) {
    green = false;
    lines.push(`tests        FAIL      ${tests.summary}`);
  } else {
    lines.push(`tests        pass      ${tests.summary.split(' — ')[0] ?? tests.summary}`);
  }

  const broken = testsUnproven ? [] : continuity(run.state.redCases, run.state.observations);
  if (broken.length > 0) {
    green = false;
    lines.push(`continuity   FAIL      ${broken.length}/${run.state.redCases.length} red cases not green now`);
    for (const b of broken.slice(0, 8)) lines.push(`  ${b}`);
  } else {
    lines.push(`continuity   pass      ${run.state.redCases.length}/${run.state.redCases.length} red cases now green`);
  }

  const report = await runChecks({
    apiRoot: run.workspace.apiRoot,
    registry: run.registry,
    runId: run.runId,
    reportsRoot: run.repoRoot,
    task: run.task,
    saveRaw: (label, content) => run.evidence.saveRaw(label, content),
  });
  run.state.lastCheck = `verdict ${report.verdictPct}%`;
  const tsc = report.rules.find((r) => r.id === 'tsc-strict');
  lines.push(`tsc          ${tsc === undefined ? 'UNPROVEN  tsc-strict rule not installed' : `${tsc.status === 'pass' ? 'pass    ' : tsc.status === 'fail' ? 'FAIL    ' : tsc.status.toUpperCase()}  ${tsc.failing} errors`}`);
  if (tsc === undefined) {
    green = false;
    unproven.push('tsc: tsc-strict rule not installed');
  }
  unproven.push(...report.unproven);
  if (!report.green) {
    green = false;
    lines.push(`standards    FAIL      verdict ${report.verdictPct}%`);
    lines.push(...compactReport(report, 10).split('\n').map((l) => `  ${l}`));
  } else {
    lines.push(`standards    pass      verdict ${report.verdictPct}% (${report.rules.filter((r) => r.status === 'pass').length} rules pass, ${report.rules.filter((r) => r.status === 'n/a').length} n/a)`);
  }

  for (const gate of extra) {
    const result = await gate(run, report);
    lines.push(...result.lines);
    unproven.push(...result.unproven);
    if (!result.green) green = false;
  }
  return { green, lines, unproven };
}
