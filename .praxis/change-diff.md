# Change diff — PRX-F47 scheduled ticket runs

## Recovery findings

- **QA finding: missed-run test failed at `scheduledRuns.spec.ts:190` when saving a timestamp from 2020.** The timestamp is deliberately written directly to the persisted profile while the app is closed to simulate an overdue schedule. It is not passed through the schedule save API. The miss-resolution transition sets the scheduled instant to the current time, and the focused scheduler core suite confirms this path. No product change was needed for this report.
- **QA finding: due-schedule test failed with “The start time has already passed.”** `scheduleSoon` accepted a seconds delay but saved only `HH:mm`, discarding seconds. Near a minute boundary, the resulting wall time could be in the past by the time IPC validated it. The helper now chooses a minute at least one minute beyond the requested delay, keeping the schedule valid while the test later edits the persisted timestamp with the app closed to make it due.

## Included implementation changes

- Extended the scheduled run view contract to expose provider headroom for a paused run even when no ticket is active.
- Updated the monitor to show this headroom and to offer skip for the ticket named by a launch-policy pause.
- Updated test teardown to remove scheduled entries before quitting, avoiding the intentional pending-schedule quit guard from blocking isolated test cleanup.
- Regenerated the Praxis test catalog from current source tests.
- Hardened `scheduleSoon` against minute truncation and timestamp races.

## Verification

- `npm run check-types` — passed.
- Focused scheduler core tests — 69 passed.
- `npm run test:praxis-contracts` — passed after regenerating the catalog (695 contracts).
- `npm run test:desktop -- scheduledRuns.spec.ts` — blocked before app startup by sandbox loopback denial (`listen EPERM: operation not permitted 127.0.0.1`).
- `npm run test:core` — attempted; unrelated FolderService watcher tests hit file-watcher resource errors (`EMFILE`) during the broad parallel suite. The directly relevant scheduled-run tests passed serially.

## Scope

No workflow definition, stage status, or unrelated ticket was changed.
