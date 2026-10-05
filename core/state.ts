// Run state (observation ledger, written files, scope) and the evidence writer for runs/<runId>/ (spec §5.9).
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import fg from 'fast-glob';
import { redact } from './redact.js';
import type { RunStateView, TestCaseObservation } from './sdk.js';

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export class RunState implements RunStateView {
  readonly writtenFiles: string[] = [];
  observations: TestCaseObservation[] = [];
  /** Every test case ever seen red in this run (file + full name); all must end green (G3 continuity). */
  readonly redCases: { file: string; name: string; turn: number; kind: string }[] = [];
  acceptedScope: string[] | null = null;
  readonly openBlocks: string[] = [];
  lastTest: string | undefined;
  lastCheck: string | undefined;
  /** Brownfield: breaking/additive contract changes from the last finish gate (additive ones go into the PR body). */
  contractChanges: { breaking: string[]; additive: string[] } | undefined;
  /** Per-tool scratch memory (e.g. read_file's unchanged-reread cache). */
  readonly memory = new Map<string, Map<string, unknown>>();
  /** Source → mapped test files; filled by the test-map builder. */
  testMap: (source: string) => string[] = () => [];

  lastTestSummary(): string | undefined {
    return this.lastTest;
  }

  lastCheckSummary(): string | undefined {
    return this.lastCheck;
  }

  mappedTests(sourceFile: string): string[] {
    return this.testMap(sourceFile);
  }

  recordWrite(rel: string): void {
    if (!this.writtenFiles.includes(rel)) this.writtenFiles.push(rel);
  }

  toolMemory(tool: string): Map<string, unknown> {
    let mem = this.memory.get(tool);
    if (mem === undefined) {
      mem = new Map();
      this.memory.set(tool, mem);
    }
    return mem;
  }
}

/** Writes runs/<runId>/ evidence. Every write is redacted. */
export class Evidence {
  readonly dir: string;
  private rawCount = 0;

  constructor(
    readonly repoRoot: string,
    readonly runId: string,
  ) {
    this.dir = join(repoRoot, 'runs', runId);
    mkdirSync(join(this.dir, 'raw'), { recursive: true });
  }

  rel(path: string): string {
    return relative(this.repoRoot, path).split('\\').join('/');
  }

  private append(file: string, entry: unknown): void {
    appendFileSync(join(this.dir, file), `${redact(JSON.stringify(entry))}\n`);
  }

  event(entry: Record<string, unknown>): void {
    this.append('events.jsonl', { ts: new Date().toISOString(), ...entry });
  }

  transcript(entry: Record<string, unknown>): void {
    this.append('transcript.jsonl', entry);
  }

  driverLog(entry: Record<string, unknown>): void {
    this.append('driver.log', { ts: new Date().toISOString(), ...entry });
  }

  saveRaw(label: string, content: string): string {
    this.rawCount += 1;
    const safe = label.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 40);
    const path = join(this.dir, 'raw', `${this.rawCount}-${safe}.txt`);
    writeFileSync(path, redact(content));
    return this.rel(path);
  }

  writeText(name: string, content: string): string {
    const path = join(this.dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, redact(content));
    return this.rel(path);
  }

  writeJson(name: string, value: unknown): string {
    return this.writeText(name, `${JSON.stringify(value, null, 2)}\n`);
  }

  readEvents(): Record<string, unknown>[] {
    const path = join(this.dir, 'events.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => {
        const parsed: unknown = JSON.parse(l);
        return typeof parsed === 'object' && parsed !== null ? Object.fromEntries(Object.entries(parsed)) : {};
      });
  }
}

/**
 * sha256 over the task file, plugins/hooks/** and plugins/rules/** — identical fingerprints prove two runs used
 * the same task, hooks and checks (spec §5.9).
 */
export function fingerprint(harnessRoot: string, taskAbsPath: string): { sha256: string; files: number } {
  const files = fg.sync(['plugins/hooks/**/*', 'plugins/rules/**/*'], { cwd: harnessRoot, onlyFiles: true, dot: false }).sort();
  const hash = createHash('sha256');
  hash.update(`task\0${sha256(readFileSync(taskAbsPath))}\n`);
  for (const file of files) hash.update(`${file}\0${sha256(readFileSync(join(harnessRoot, file)))}\n`);
  return { sha256: hash.digest('hex'), files: files.length + 1 };
}
