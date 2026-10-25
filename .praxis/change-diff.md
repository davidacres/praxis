# change-diff — PRX-S47-148

Commit: `4d41f0d5` — feat(scheduled-runs): persist audit evidence and hand over active stages
Base: `d1e624fb`

The complete patch is [change-diff.patch](session-artifacts/change-diff.patch).

## Changes

- Core scheduled-run contracts and normalization now retain measured token/cost ranges (or an explicit not-estimable reason) independently of actual spend, plus workflow artifact references. Progress updates and retries preserve that evidence.
- Electron observations collect estimates from the existing workflow estimator and artifacts from workflow nodes. Threshold checks use the live session provider after a handover.
- A stage handover guard keeps the workflow's completion waiter attached while the old turn is intentionally aborted. The adapter checkpoints the active session's worktree, invokes the existing session handover path (including its durable brief and context validation), and changes the provider for later stages. Cancellation checks prevent restarting a workflow stopped during handover. Ambiguous active sessions fail closed.
- Failed handovers and absent provider headroom pause the schedule rather than retrying on every tick.
- Added regression coverage for durable evidence, persistent pauses, handover failures, intentional interruption, and real-Electron same-session gateway-to-ACP handover. Registered the guard tests in the workflow test command and regenerated the test catalog.

## Automated checks

| Command | Result |
| --- | --- |
| `npm run build:core` | Passed after correcting the new test's dynamic import (see failures below). |
| `npm run build:desktop` | Passed after making this worktree resolve its own core build through an ignored local workspace link. Subsequent E2E invocations also compiled desktop successfully. |
| `npm run build:renderer` | Passed; Vite emitted its chunk-size warning. |
| `npm run test:core` | Initial sandbox invocation failed on local-server permissions; permitted invocation passed: 1,693 passed, 2 skipped, 0 failed (1,695 total). |
| `node --test packages/core/out/scheduledRuns/*.test.js` | 89 passed, 0 failed, 0 skipped. |
| `node --test apps/praxis-desktop/main/out/main/stageHandoverGuard.test.js` | 2 passed, 0 failed, 0 skipped. |
| `npm run test:desktop:workflows` | 79 passed, 0 failed, 0 skipped. |
| `npm run test:desktop` | Initial sandbox invocation failed to bind local mock servers. |
| `npm run test:desktop -- --output=/tmp/wf087-e2e-results` | Interrupted after an out-of-scope ACP compaction failure: 166 passed, 1 failed, 4 interrupted, 486 not run. Exit 130. This is not a completed broad-suite pass. |
| `npm run test:desktop -- scheduledRuns.spec.ts --grep 'a due schedule starts by itself' --workers=1 --output=/tmp/wf087-focused-results` | 1 passed, 0 failed. |
| `npm run test:desktop -- scheduledProviderHandover.spec.ts --workers=1 --output=/tmp/wf087-handover-active-results` | Final corrected regression: 1 passed, 0 failed. Two earlier setup/assertion failures are preserved below and in logs. |
| `npm run test:desktop -- scheduledRuns.spec.ts --workers=2 --output=/tmp/wf087-scheduled-results` | 22 passed, 1 opt-in capture skipped, 0 failed. Playwright ran this single file with 1 worker. |
| `npm run check-types` | Core, renderer, desktop and relay checks passed; mobile-protocol failed on two unavailable imports below. No unrelated dependency changes made. |
| `node apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs --write` | Generated 710 contracts, carrying over 708 existing contracts. Also picked up one existing uncatalogued schedule test. |
| `npm run test:praxis-contracts` | Passed: 710 tests catalogued and linked. |
| `git diff --check` / `git diff --cached --check` | Passed. |

### Failure evidence

Initial sandbox failure:

```text
Error: listen EPERM: operation not permitted 127.0.0.1
```

Initial desktop compilation resolved core from the main checkout rather than this worktree:

```text
src/main/scheduledRunLive.ts(102,37): error TS2353: Object literal may only specify known properties, and 'estimate' does not exist in type '{ kind: "running"; provider?: string | undefined; sessionId?: string | undefined; spend?: ScheduledEntrySpend | undefined; exhausted?: readonly string[] | undefined; }'.
```

A newly added test's dynamic import was replaced with an ordinary static import:

```text
src/scheduledRuns/scheduledRunStore.test.ts(146,93): error TS2835: Relative import paths need explicit file extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'. Did you mean './scheduledRunExecution.js'?
```

The new E2E first omitted schedule date/time, then assumed an executing state although a held gateway turn was planning. Both fixture assumptions were corrected; final production-path test passed:

```text
Error: page.evaluate: Error: Error invoking remote method 'scheduledRuns:save': Error: undefined undefined is not a valid time in UTC. Clocks may change at that hour; pick another time.

Error: expect(received).toBe(expected) // Object.is equality
Expected: "executing"
Received: "planning"
```

Broad desktop failure (`e2e/aiAcpModesAndCommands.spec.ts:130`), outside changed scheduled-run paths:

```text
Error: expect(received).toBe(expected) // Object.is equality
Expected: true
Received: false
Call Log:
- Timeout 20000ms exceeded while waiting on the predicate
```

Root type-check failure:

```text
src/noise.ts(16,24): error TS2307: Cannot find module '@noble/curves/ed25519' or its corresponding type declarations.
src/noise.ts(17,34): error TS2307: Cannot find module '@noble/ciphers/chacha' or its corresponding type declarations.
```

## Snapshots

None added or updated.

## Manual and visual checks

Real Electron E2E interactions exercised creating, ordering, saving, restarting, scheduling, missed starts, provider budget pauses, run-now, skip/resume/retry, workflow approval and quit warning behavior. These interactions were automated, not an additional hand-driven session.

Opened and inspected the fresh budget-pause capture from the focused run. Checked warning and control alignment, queue ordering, provider usage label/bar, and absence of overlap or truncation. Preserved that exact inspected image as `session-artifacts/budget-pause-verified.png` before later tests could overwrite their normal capture path. No renderer/CSS changes or snapshot updates were needed.

The new Electron regression holds a gateway response open, writes a file to a temporary workflow worktree, changes usage to 95%, and verifies the file in the recorded checkpoint, the same workflow/session IDs, provider transition, durable brief revision, successful replacement completion, approval boundary, and collected artifacts.

## Not verified

- No production-account multi-provider calls were made. Handover was exercised through the production host/session/workflow path using a local gateway mock and a real fixture ACP subprocess.
- The full functional suite did not complete; its ACP compaction failure remains unresolved outside ticket scope.
- Root type checking is not fully green because mobile-protocol imports are unavailable.
- No separate mouse-driven manual session or complete theme matrix was run; visual inspection covers the retained light-theme budget-pause state.

## Recovery verification (2026-10-25)

QA reported failures in `autoUpdate.test.js`, `gitService.test.js`, `minimaxUsage.test.js`, `ticketReviewApply.test.js`, and `windowState.test.js`. The exact `npm run test:git --workspace=@praxis/desktop-main` command was rerun in this checkout: all five reported files passed, and the complete suite passed (84 passed, 0 failed) when local loopback access was available. In the restricted invocation, the four failures were instead in `semanticModelDownload.test.js`, each caused by `listen EPERM` while binding its local HTTP fixture to `127.0.0.1`; rerunning with loopback access passed those tests too. No product-code change was warranted by this environment-only failure.

The full implementation patch is preserved at `session-artifacts/change-diff.patch` for this recovery handoff.

### Recovery iteration 3 (2026-10-25)

QA reported five failing test files: `autoUpdate.test.js`, `gitService.test.js`, `minimaxUsage.test.js`, `ticketReviewApply.test.js`, and `windowBroadcast.test.js`. The exact `npm run test:git --workspace=@praxis/desktop-main` command was rerun. All five reported files passed; the restricted run instead failed four tests in `semanticModelDownload.test.js` because the sandbox denied binding local HTTP fixtures to `127.0.0.1` (`listen EPERM`). With local loopback access, the complete suite passed: 84 passed, 0 failed. No product-code repair was indicated; the finding was an execution-environment restriction.

## Risks

- Allowance detection remains polling-based and can overshoot the threshold between readings.
- A no-headroom schedule pause blocks queue advancement; it does not forcibly abort the already active workflow turn. Hard provider-limit recovery remains owned by the workflow engine.
- Handover requires exactly one active matching stage session. Ambiguous concurrent stage sessions pause for user attention.
- Estimates preserve the first observation and explicitly remain not estimable when historical usage is insufficient; no token pricing is invented.
- No workflow definitions, tracker statuses, approvals or other delivery stages were changed. No push or deployment performed.

Full command logs are retained in `session-artifacts/` alongside the inspected screenshot.

### Recovery iteration 5 (2026-10-25)

QA finding addressed: the test hovered the outer `.easymode-automation-card`, while CSS reveals actions from `.easymode-automation-row:hover`. The test now scopes hover and click to that styled child, preserving the hidden-at-rest, visible-on-hover, stable-title-width, and action behavior assertions. No production CSS change was needed.

- Focused Electron Playwright test passed: 1 passed, 0 failed.
- `git diff --check` passed.
- The first sandboxed test attempt stopped before assertions because Electron could not bind `127.0.0.1` (`listen EPERM`). The focused test passed when rerun with loopback access.
- The resulting sidebar screenshot is preserved at `session-artifacts/easymode-automation-row-actions.png`.
- The recovery patch is [change-diff-recovery.patch](session-artifacts/change-diff-recovery.patch).
