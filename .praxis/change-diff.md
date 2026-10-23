# Change diff — PRX-F47 scheduled ticket runs

## Recovery findings

QA reported five failing files in `npm run test:git`: `gitService.test.js`, `minimaxUsage.test.js`, `ticketReviewApply.test.js`, `windowBroadcast.test.js`, and `windowState.test.js`.

The reported failures were not reproducible as those test failures in this checkout. The command completed with 74 passing and 4 failing tests. All four failures were in `semanticModelDownload.test.js`, whose local HTTP fixture cannot bind `127.0.0.1` in this sandbox (`listen EPERM: operation not permitted`). The reported `gitService`, `minimaxUsage`, `ticketReviewApply`, `windowBroadcast`, and `windowState` tests passed in the same run. This matches the repository's known sandbox loopback restriction, rather than indicating a scheduled-run code regression.

No source changes were made for this report. The local HTTP tests must be rerun in an environment permitted to bind loopback; the test behavior and checks were left intact.

## Verification

- `npm run test:git --workspace=@praxis/desktop-main` — compile passed; 74 tests passed; 4 `semanticModelDownload` tests failed at local server startup with sandbox `EPERM`.
- The five QA-reported test files all passed in that run.

## Scope

No workflow definition, stage status, or unrelated ticket was changed.
