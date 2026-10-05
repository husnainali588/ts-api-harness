#!/usr/bin/env bash
# Simulates the graders end to end. OFFLINE by default (no model calls). `--live` instead performs the two real driver
# runs on the greenfield task (paid: needs a key and explicit approval).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
TASK="${TASK:-tasks/users.yaml}"
API="${API:-generated/users-api}"
failures=0
step() { echo; echo "════ $*"; }
ok() { echo "   ok: $*"; }
bad() { echo "   FAIL: $*"; failures=$((failures + 1)); }

if [ "${1:-}" = "--live" ]; then
  step "LIVE: same task, two drivers (paid)"
  npx --no-install harness run --task "$TASK" --driver claude --max-run-tokens "${MAX_RUN_TOKENS:-150000}" --total-budget "${TOTAL_BUDGET:-650000}" || bad "claude run not green"
  npx --no-install harness run --task "$TASK" --driver openai --max-run-tokens "${MAX_RUN_TOKENS:-150000}" --total-budget "${TOTAL_BUDGET:-650000}" || bad "openai run not green"
fi

step "1. clean tree"
if [ -z "$(git status --porcelain --untracked-files=no)" ]; then ok "no uncommitted changes to tracked files"; else bad "uncommitted changes:"; git status --short --untracked-files=no; fi

step "2. model agnosticism: committed claude + openai evidence runs"
HARNESS_NO_DOTENV=1 node --input-type=module -e "
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const runs = existsSync('runs') ? readdirSync('runs').filter((d) => existsSync('runs/' + d + '/summary.json')) : [];
const tracked = new Set(process.argv[1].split('\n'));
const s = runs.filter((d) => tracked.has('runs/' + d + '/summary.json')).map((d) => JSON.parse(readFileSync('runs/' + d + '/summary.json', 'utf8')))
  .filter((x) => !x.baseline && x.task.path === process.argv[2] && x.tokens.source === 'provider');
const pick = (driver) => s.filter((x) => x.driver === driver && x.status === 'green').at(-1);
const c = pick('claude'), o = pick('openai');
if (!c || !o) { console.log('   FAIL: need a committed green claude run and a green openai run for ' + process.argv[2]); process.exit(1); }
console.log('   claude ' + c.runId + ' ' + c.status + ' served by ' + c.servedBy.join(',') + ' fingerprint ' + c.fingerprint.sha256.slice(0, 16));
console.log('   openai ' + o.runId + ' ' + o.status + ' served by ' + o.servedBy.join(',') + ' fingerprint ' + o.fingerprint.sha256.slice(0, 16));
if (c.fingerprint.sha256 !== o.fingerprint.sha256) { console.log('   FAIL: task/hooks/rules fingerprints differ'); process.exit(1); }
if (c.task.sha256 !== o.task.sha256) { console.log('   FAIL: task file differs'); process.exit(1); }
console.log('   ok: identical task, hooks and rules; both runs green');
" "$(git ls-files runs)" "$TASK" || failures=$((failures + 1))

step "3. API standards: harness check --api $API"
if [ -d "$API" ]; then
  HARNESS_NO_DOTENV=1 npx --no-install harness check --api "$API" --task "$TASK" | tail -14 && ok "verdict 100%" || bad "standards not at 100%"
else
  bad "$API not found"
fi

step "4. token efficiency: tokens/*.json"
HARNESS_NO_DOTENV=1 node --input-type=module -e "
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const files = existsSync('tokens') ? readdirSync('tokens').filter((f) => f.endsWith('.json')) : [];
let good = 0;
for (const f of files) {
  const r = JSON.parse(readFileSync('tokens/' + f, 'utf8'));
  console.log('   ' + f + ': ' + r.driver + ' ' + r.measuredFrom + ' — mean/turn ' + r.reductionPct.meanPerTurn + '%, total ' + r.reductionPct.total + '%, peak ' + r.reductionPct.peak + '% (target >' + r.targetPct + '%: ' + (r.met ? 'met' : 'NOT met') + ')' + (r.note ? '\n     note: ' + r.note : ''));
  if (r.evidence) good += 1;
}
if (good === 0) { console.log('   FAIL: no evidence-grade token report (provider usage)'); process.exit(1); }
" || failures=$((failures + 1))

step "5. extensibility: scripts/extension-demo.sh"
bash scripts/extension-demo.sh > /tmp/harness-extension-demo.log 2>&1 && { tail -1 /tmp/harness-extension-demo.log; ok "three additions, no core change"; } || { tail -20 /tmp/harness-extension-demo.log; bad "extension demo failed"; }

step "6. provider leak test"
HARNESS_NO_DOTENV=1 npx --no-install vitest run test/no-provider-leak.test.ts > /tmp/harness-leak.log 2>&1 && ok "no provider names or wire shapes outside drivers/" || { tail -20 /tmp/harness-leak.log; bad "leak test failed"; }

step "7. secrets in the full git history"
npx --no-install tsx scripts/scan-history.ts || bad "secret found in history"

echo
if [ "$failures" -eq 0 ]; then echo "grade.sh: ALL PASS"; else echo "grade.sh: $failures check(s) failed"; fi
exit "$failures"
