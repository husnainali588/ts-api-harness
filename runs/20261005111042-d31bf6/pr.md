## New API — tasks/users.yaml
Shipped by the harness after every gate was green. Run `20261005111042-d31bf6`, driver `scripted` (local; served by scripted).

### Finish gate
```
tests        pass      PASS 44 / FAIL 0
continuity   pass      2/2 red cases now green
tsc          pass      0 errors
standards    pass      verdict 100% (9 rules pass, 0 n/a)
```
### Standards
```
no-unsafe-ts      pass       0 sites
problem-json      pass      12/12 error paths
problem-probe     pass      25/25 probes
rest-conventions  pass      5/5 routes
task-coverage     pass      5/5 behaviours
test-assertions   pass      40/40 test cases
tests-mapped      pass      9/9 files
tsc-strict        pass       0 errors
zod-boundary      pass      5/5 handlers
verdict           100%      → all rules pass
```
### Tokens
44485 input / 2248 output tokens over 14 turns (ESTIMATE — scripted/replay driver, not evidence).

### Honesty
- Proven: tests, red→green continuity, strict tsc, standards checks and the problem probe as listed above.
- Unproven: token numbers are estimates (scripted/replayed driver), not evidence.
- Out of reach (a human must verify): business-logic correctness beyond the tests, test quality beyond red→green, security, performance, persistence semantics.
- Evidence: `runs/20261005111042-d31bf6/`, `reports/20261005111042-d31bf6/`.