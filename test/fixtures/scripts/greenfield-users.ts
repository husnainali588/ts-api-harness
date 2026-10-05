// A realistic scripted greenfield session for the users task (what a model typically does), used to estimate the
// token report offline and as a stand-in for a recorded rehearsal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Line = { text?: string; toolCalls: { name: string; input: unknown }[] };

export function greenfieldUsersScript(repoRoot: string): Line[] {
  const good = (rel: string) => readFileSync(join(repoRoot, 'test/fixtures/good-api', rel), 'utf8');
  const call = (name: string, input: unknown = {}) => ({ name, input });
  return [
    { text: 'Reading the task.', toolCalls: [call('get_task')] },
    { toolCalls: [call('list_files', { dir: '.', glob: '**/*.ts' })] },
    { toolCalls: [call('get_standard', { id: 'template' })] },
    { toolCalls: [call('read_file', { path: 'src/http/route.ts', startLine: 1, endLine: 60 })] },
    { toolCalls: [call('read_file', { path: 'src/http/store.ts' })] },
    { toolCalls: [call('write_file', { path: 'test/schemas/user.test.ts', content: good('test/schemas/user.test.ts') })] },
    { toolCalls: [call('write_file', { path: 'test/routes/users.test.ts', content: good('test/routes/users.test.ts') })] },
    { toolCalls: [call('run_tests')] },
    { toolCalls: [call('write_file', { path: 'src/schemas/user.ts', content: good('src/schemas/user.ts') })] },
    { toolCalls: [call('write_file', { path: 'src/routes/users.ts', content: good('src/routes/users.ts') })] },
    { toolCalls: [call('run_tests')] },
    { toolCalls: [call('read_file', { path: 'src/http/store.ts' })] },
    { toolCalls: [call('run_checks')] },
    { text: 'All green.', toolCalls: [call('finish', { summary: 'users API with CRUD + cursor list' })] },
  ];
}
