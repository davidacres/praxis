# BDD report: session recovery after provider credit or budget exhaustion

## Outcome and scope

A provider limit belongs to the runtime that failed. Once a user switches to a
healthy provider, the active error banner and Switch prompt should
clear without manual dismissal. Historical failure events and the original
runtime identity should remain available. A genuine new failure from the
replacement provider must still offer recovery.

The renderer now treats provider handover, model change and conversation-turn
transitions after a historical error as recovery boundaries. Historical response
buffers no longer reactivate that warning after recovery. Current explicit
limit flags and new errors still take precedence. Tests use isolated profiles
and mock providers, with no paid model calls.

## Execution plan

- [x] Inspect session limit detection, handover and existing error-banner tests.
- [x] Use two separate mock providers and the real composer recovery action.
- [x] Hold the replacement stream until in-flight assertions finish; avoid timing races.
- [x] Cover credit and spending-budget exhaustion, completion, follow-up and reopen.
- [x] Verify a genuine replacement-provider failure remains actionable.
- [x] Build, run focused Electron tests and inspect retained screenshots.
- [x] Fix historical limit detection without deleting session history.
- [x] Run the full functional suite and compare unrelated failures with the original renderer.

## Feature: continue a session with another provider

### Scenario outline: recover from the original provider's limit

**Given** an existing session on Vercel AI Gateway fails with `<limit>`
**And** the error banner and composer recovery prompt identify that failure
**And** OpenAI is configured with a separate healthy mock endpoint
**When** the user selects OpenAI and clicks **Switch**
**Then** the same session uses OpenAI and enters the executing state
**And** the old active error banner disappears without dismissal
**And** the composer no longer offers recovery for the original failure
**And** it does not claim that OpenAI has exhausted its budget
**When** OpenAI completes the work
**Then** the normal composer shows OpenAI and accepts a follow-up
**And** active `lastError` and `providerLimitReached` values are clear
**And** historical error events and Vercel runtime history remain recorded
**When** the user sends a follow-up and reloads/reopens the session
**Then** requests go to OpenAI, not the exhausted endpoint
**And** the old warning and switch prompt stay absent.

| Example | Original provider response | Result |
| --- | --- | --- |
| Credit exhaustion | HTTP 429, insufficient balance / recharge required | PASS: warning and switch prompt clear during OpenAI execution |
| Budget exhaustion | HTTP 429, provider spending budget exceeded | PASS: warning and switch prompt clear during OpenAI execution |

Both examples were proven to fail against the original renderer during OpenAI
execution. They now pass during execution, after completion, after a follow-up,
and after renderer reload/reopen. Assertions are soft so all later checks still
execute; any failed assertion still fails the test. A renderer
reload is covered here, not a full Electron-process restart.

### Scenario: the replacement provider also runs out of credits

**Given** the original provider has exhausted its credits
**When** the user switches to OpenAI
**And** OpenAI returns its own insufficient-quota error
**Then** the session fails on OpenAI with OpenAI's new error recorded
**And** the limit banner is visible
**And** the composer correctly identifies OpenAI as reaching its usage limit
**And** **Switch** remains enabled.

**Result:** PASS. Recovery must not indiscriminately hide genuine new failures.

## Feature: choose recovery using provider and model chips

The composer now reuses the existing themed provider and model chips. Both are
draft selections until **Switch** is pressed. The split button menu offers
**Switch**, **Retry with the original provider and model**, and **Stop**. Retry
replays the failed user turn and attachments on the existing runtime. A new retry
input retires historical errors while the new request is running.

| Given | When | Then | Focused result |
| --- | --- | --- | --- |
| A provider with multiple models | A non-default model is selected and Switch is double-clicked | Draft selection leaves the session unchanged; one request uses the exact pair | PASS |
| The original provider is topped up and replacement chips have changed | Retry is chosen | The original provider/model receives the retry; stale warnings clear during execution | PASS |
| The recovery menu is open | Escape or Stop is chosen | Escape returns focus without a request; Stop closes recovery and retains history | PASS |
| Six usable providers and a wide or narrow pane | Recovery and its action menu are shown | Only two chips and the split button remain inline; menus fit within the pane/window | PASS |
| A configured default is absent from the catalog | That provider is selected | The configured default is pinned, selected and sent explicitly | PASS |
| Model discovery fails | The user reloads models | Switch is blocked until loading succeeds; no premature request is sent | PASS |
| An earlier provider catalog responds late | A different provider has already been selected | The latest provider/model remains selected | PASS |
| A runtime exposes no catalog | That replacement is selected | Provider-default fallback is explicit | PASS |

The model selection resets on each provider change. Disabled/unconfigured
providers and providers explicitly lacking tool support are excluded using the
shared renderer eligibility rule. Duplicate actions are guarded before IPC.
Catalog-loading failures remain recoverable through **Reload models**.

## Validation and evidence

- Shared core build: passed after allowing output writes outside the desktop sandbox.
- Renderer production build, including core-import enforcement and type checking: passed.
- Desktop type checking and compilation: passed.
- Before the fix: **1 passed, 2 failed**, reproducing the reported defect.
- Historical-warning fix: the original regression file **3 passed**.
- Chips and split actions: focused regression file **11 passed** plus the two
  existing ACP provider-switch/Stop scenarios (**13 passed** total).
- Existing provider-not-configured and running-session handover-control tests: passed.
- Earlier historical-warning fix full functional desktop suite: **420 passed, 2 skipped, 11 failed** (9.6 minutes).
  Ran in a temporary copy of the current working tree to preserve existing
  workspace artifacts. The three recovery scenarios passed in this run too.
- Nine failures also reproduce using the pre-fix renderer: CLI analysis
  confirmation; Autopilot sidebar state; the archive-dialog label; two provider
  analysis scenarios; local peer review; two workflow-session grouping scenarios;
  and controller-session run grouping. These are outside this recovery fix.
- The other two failures (Agent Runtime button theme and deleting a live run)
  pass in isolated reruns with both the original and fixed renderer.
- Final chips/action-menu full functional suite: **430 passed, 2 skipped, 9 failed**
  (441 total, 9.0 minutes). All thirteen recovery checks passed within this run.
  The nine failures match the previously reproduced baseline failures listed above.
  The intermittent theme and live-run deletion checks passed in this run.
  Log: `/tmp/praxis-recovery-chips-final-suite.log`. The final build was tested in
  `/tmp/praxis-recovery-chips-verification-f97pkcu9` to preserve working-tree captures.
- Inspected actual Electron captures `provider-recovery-chips-wide.png` and
  `provider-recovery-chips-narrow.png` under `.praxis/session-artifacts/`: both
  chips, split action, and all three menu choices fit; the narrow menu wraps
  the original retry destination without horizontal overflow.
- No snapshots updated. The full suite is not green; no unrelated code was
  changed to silence its existing failures.
- Electron UI interactions exercised failure, provider selection, Switch,
  streaming, completion, sending a follow-up, and reload/reopen.
- Inspected `.praxis/session-artifacts/provider-limit-stale-running.png`: OpenAI's
  reply is visible while the old quota banner and false OpenAI budget prompt remain
  in the pre-fix capture, retained for comparison.
- Inspected `.praxis/session-artifacts/provider-limit-fixed-running.png`: OpenAI
  is executing, its reply is visible, the old banner and switch prompt are absent,
  and the composer shows Working. Original failure details remain in runtime history.
- Inspected `.praxis/session-artifacts/provider-limit-recovered.png`: after completion
  and reopening, the warning is absent and the normal OpenAI composer is restored.

Run from the repository root:

```bash
npm run build:core
npm run build:renderer
npm run test:desktop -- sessionProviderLimitRecovery.spec.ts
```

## Completion criteria

All eleven recovery BDD scenarios and both existing ACP recovery checks must pass.
Actual app captures must show two chips and the split action at wide and narrow
widths, with its open menu fitting within the viewport. Streaming recovery must
show no stale warning, while genuinely new limit failures still offer recovery.
The focused criteria pass; the full-suite result is recorded separately above.
