# change-diff — PRX-T113-496

Base revision: `8856cb7b`.

## Implemented scope

- Added JSON-compatible project note/group records, ordered many-to-many links, version-one storage, CRUD inputs, detached request snapshots, and discriminated IPC results with stable error codes.
- Added pure unknown-input validation: absent storage initializes an empty document without writing; malformed data and unsupported versions fail explicitly. Valid records are copied. Titles trim and enforce 200 UTF-16 units; bodies preserve whitespace and enforce 1,000,000 units. Immutable patch fields, invalid timestamps, duplicate identities, broken links and cross-project memberships are rejected.
- Added explicit project-existence and entity-ownership checks, ordered membership validation, and pure snapshot preparation with injected capture time. Captures preserve content, provenance and order independently of later changes/deletion; empty or incomplete groups fail.
- Declared the future NotesIpc surface without adding it to preload or the operational application API. Documented post-persistence notification and atomic membership cleanup requirements for TASK-497.
- Exported the contracts/helpers and registered nine contract tests in the core suite.

Persistence, handlers, preload wiring, UI, workspace exports, session submission and scheduled runs are unchanged. TASK-497 and FX-BE-191 retain their planned integration responsibilities.

## Recovery diagnosis

The supplied prior-run report contains only “Implement failed,” with no structured findings or diagnostics. The initial tree was clean and contained no notes implementation. The previous change-diff described unrelated scheduled-run work; this artifact now describes TASK-496. Existing unrelated evidence files remain untouched.

Implementation verification initially caught three test-fixture mistakes: assignment to readonly createdAt, a default argument masking an undefined-source test, and a substring assertion matching “id” inside “Invalid.” These were corrected without weakening domain checks. Final notes tests and the approved full core run pass.

## Verification

| Check | Result |
| --- | --- |
| `npm run build:core` | Passed. |
| `node --test packages/core/out/notes/noteValidation.test.js packages/core/out/notes/noteSnapshot.test.js` | Passed: 9 tests. |
| `npm run test:core` | Approved rerun passed: 1,811 tests, 1,809 passed, 2 skipped, 0 failed. Initial sandbox run encountered local socket EPERM and watcher EMFILE failures, plus the two subsequently corrected test assertions. |
| `npm run check-types` | Failed in unchanged mobile-protocol/src/noise.ts: missing @noble/curves/ed25519 and @noble/ciphers/chacha modules (TS2307). Other workspace checks, including core and renderer, passed. No dependency or lockfile changes made. |
| `npm run build:renderer` | Passed with filesystem approval after initial EPERM writing Vite cache under shared node_modules. Core-import guard, renderer typecheck, and Vite build passed; existing chunk-size warning remains. |
| `npm run test:praxis-contracts` | Passed: 732 Playwright tests catalogued. |
| `git diff --check` | Passed. |

No UI code changed; manual UI checks, screenshots and desktop e2e are outside this task's supplied verification plan. No workflow stages were advanced and no tracker updates were made.
