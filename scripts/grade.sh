#!/usr/bin/env bash
# Simulates the graders end to end. OFFLINE by default (no model calls). Reports what exists: anything that needs live
# evidence which is not in the repo prints UNPROVEN — never pass. `--live` performs the two real driver runs first
# (paid: needs a key and explicit approval).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export HARNESS_NO_DOTENV=1
TASK="${TASK:-tasks/users.yaml}"
API="${API:-generated/users-api}"
pass=0; unproven=0; fail=0
step() { echo; echo "════ $*"; }
ok() { echo "   PASS: $*"; pass=$((pass + 1)); }
none() { echo "   UNPROVEN: $*"; unproven=$((unproven + 1)); }
bad() { echo "   FAIL: $*"; fail=$((fail + 1)); }

if [ "${1:-}" = "--live" ]; then
  unset HARNESS_NO_DOTENV
  step "LIVE: same task, two drivers (paid)"
  npx --no-install harness run --task "$TASK" --driver claude --max-run-tokens "${MAX_RUN_TOKENS:-200000}" --total-budget "${TOTAL_BUDGET:-1200000}" || echo "   claude run not green"
  npx --no-install harness run --task "$TASK" --driver openai --max-run-tokens "${MAX_RUN_TOKENS:-200000}" --total-budget "${TOTAL_BUDGET:-1200000}" || echo "   openai run not green"
  export HARNESS_NO_DOTENV=1
fi

step "1. clean tree"
if [ -z "$(git status --porcelain --untracked-files=no)" ]; then ok "no uncommitted changes to tracked files"; else bad "uncommitted changes to tracked files"; git status --short --untracked-files=no; fi

step "2. model agnosticism: committed live runs (provider usage)"
result="$(node --input-type=module -e "
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const tracked = new Set(process.argv[1].split('\n'));
const runs = (existsSync('runs') ? readdirSync('runs') : []).filter((d) => tracked.has('runs/' + d + '/summary.json'))
  .map((d) => JSON.parse(readFileSync('runs/' + d + '/summary.json', 'utf8'))).filter((x) => !x.baseline && x.tokens.source === 'provider');
for (const r of runs) console.log('   live run ' + r.runId + ' ' + r.driver + ' (' + r.servedBy.join(',') + ', ' + r.transports.join(',') + '): ' + r.status.toUpperCase() + ' — ' + r.reason);
const green = (d) => runs.filter((x) => x.driver === d && x.status === 'green' && x.task.path === process.argv[2]).at(-1);
const c = green('claude'), o = green('openai');
if (!c || !o) { console.log('RESULT unproven no live run of ' + process.argv[2] + ' finished green on ' + [!c && 'claude', !o && 'openai'].filter(Boolean).join(' and ')); process.exit(0); }
console.log(c.fingerprint.sha256 === o.fingerprint.sha256 && c.task.sha256 === o.task.sha256 ? 'RESULT pass identical task, hooks and rules; both green' : 'RESULT fail fingerprints differ');
" "$(git ls-files runs)" "$TASK")"
echo "$result" | grep -v '^RESULT'
case "$(echo "$result" | grep '^RESULT' | cut -d' ' -f2)" in
  pass) ok "$(echo "$result" | grep '^RESULT' | cut -d' ' -f3-)" ;;
  fail) bad "$(echo "$result" | grep '^RESULT' | cut -d' ' -f3-)" ;;
  *) none "$(echo "$result" | grep '^RESULT' | cut -d' ' -f3-)" ;;
esac
echo "   (the offline gates are exercised by npm test with the scripted driver; tests/fixtures prove both driver wire formats)"

step "3. API standards: harness check --api $API"
if [ -d "$API" ]; then
  out="$(npx --no-install harness check --api "$API" --task "$TASK")"; code=$?
  echo "$out" | tail -12
  if [ "$code" -eq 0 ]; then ok "verdict 100%"; else bad "standards not at 100%"; fi
else
  none "$API is not in the repo: no live run produced it. (The scripted-driver run's API is on the PR branch; npm test checks the reference API at 100%.)"
fi

step "4. token efficiency: tokens/*.json"
node --input-type=module -e "
import { readFileSync, readdirSync, existsSync } from 'node:fs';
const files = existsSync('tokens') ? readdirSync('tokens').filter((f) => f.endsWith('.json') && f !== 'live-runs.json') : [];
let evidence = 0;
for (const f of files) {
  const r = JSON.parse(readFileSync('tokens/' + f, 'utf8'));
  console.log('   ' + f + ': ' + r.measuredFrom + ' — mean/turn ' + r.reductionPct.meanPerTurn + '%, total ' + r.reductionPct.total + '%, peak ' + r.reductionPct.peak + '% (target >' + r.targetPct + '%: ' + (r.met ? 'met' : 'NOT met') + ', evidence: ' + r.evidence + ')');
  if (r.evidence) evidence += 1;
}
if (existsSync('tokens/live-runs.json')) for (const r of JSON.parse(readFileSync('tokens/live-runs.json', 'utf8')).runs) console.log('   live ' + r.runId + ' ' + r.driver + ': ' + r.turns + ' turns, mean input ' + r.meanInputTokensPerTurn + '/turn, peak ' + r.peakInputTokens + ' (' + r.outcome + ')');
process.exit(evidence > 0 ? 0 : 3);
"
case $? in
  0) ok "an evidence-grade token report exists" ;;
  3) none "no evidence-grade token report (no live baseline was run); offline estimates and live actual-mode numbers shown above" ;;
  *) bad "token report unreadable" ;;
esac

step "5. extensibility: scripts/extension-demo.sh"
if bash scripts/extension-demo.sh > /tmp/harness-extension-demo.log 2>&1; then tail -1 /tmp/harness-extension-demo.log; ok "three additions, no core change"; else tail -20 /tmp/harness-extension-demo.log; bad "extension demo failed"; fi

step "6. provider leak test"
if npx --no-install vitest run test/no-provider-leak.test.ts > /tmp/harness-leak.log 2>&1; then ok "no provider names or wire shapes outside drivers/"; else tail -20 /tmp/harness-leak.log; bad "leak test failed"; fi

step "7. secrets in the full git history"
if npx --no-install tsx scripts/scan-history.ts; then ok "history clean"; else bad "secret found in history"; fi

echo
echo "grade.sh: $pass PASS, $unproven UNPROVEN, $fail FAIL"
[ "$fail" -eq 0 ]
