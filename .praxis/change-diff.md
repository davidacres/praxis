# Change diff — PRX-F47 scheduled ticket runs

## Recovery findings

Iteration 6 reported failures in `autoUpdate.test.js`, `gitService.test.js`, `ticketReviewApply.test.js`, and `windowBroadcast.test.js` during `npm run test:git`. The supplied output only identifies those files as failing; it does not include the individual assertion or error details.

I reran `npm run test:git --workspace=@praxis/desktop-main` in this checkout. Compilation succeeded, and all four named files passed in the reproduced run: `autoUpdate.test.js`, `gitService.test.js`, `ticketReviewApply.test.js`, and `windowBroadcast.test.js`. The run finished with 74 passing and 4 failing tests. The four failures were all in `semanticModelDownload.test.js`, where its local HTTP fixtures failed to bind `127.0.0.1` with `listen EPERM: operation not permitted` before the test behavior ran.

No product change was justified by the evidence: none of the reported test files failed on reproduction, and the actual failures are caused by this environment denying loopback server startup. I left the production code and test assertions unchanged. The loopback-dependent tests still need a run in an environment that permits binding `127.0.0.1`.

## Iteration 6 dispositions

| QA-reported test file | Reproduced result | Disposition |
| --- | --- | --- |
| `autoUpdate.test.js` | Passed | No source fix indicated by this rerun. The iteration excerpt has no test-level error to target. |
| `gitService.test.js` | Passed | No source fix indicated by this rerun. The iteration excerpt has no test-level error to target. |
| `ticketReviewApply.test.js` | Passed | No source fix indicated by this rerun. The iteration excerpt has no test-level error to target. |
| `windowBroadcast.test.js` | Passed | No source fix indicated by this rerun. The iteration excerpt has no test-level error to target. |

## Verification

- `npm run test:git --workspace=@praxis/desktop-main` — compile passed; 74 passed, 4 failed. All four failures were `semanticModelDownload.test.js` fixtures blocked by loopback `EPERM`.
- The four files named by iteration 6 all passed in that run.

## Scope

This recovery changes only this diagnostic artifact. It does not modify the workflow definition, workflow stage, scheduled-run source, or unrelated ticket state.
