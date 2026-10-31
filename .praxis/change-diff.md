# change-diff — PRX-T113-496

## Current recovery — explicit acceptance boundary

Recovery base: `50c62248`. This recovery changes only TASK-496's checked-in acceptance text and this artifact; the implementation and all verification gates are preserved. Earlier sections below describe previous revisions.

The supplied medium quality finding is addressed through its contracts-only alternative. The prior recovery explained the boundary only in this report, leaving the actual task acceptance ambiguous. `apps/praxis-desktop/docs/plans/features/fx-bf-113-shelf-and-sidebar-notes/stories/fx-be-189/tasks/task-496.md` now explicitly defines pure schema initialisation, transport contract proof and the limits of `PERSISTENCE_FAILURE` evidence. TASK-497 retains operational storage, main/preload handlers, atomic persistence, notifications and restart restoration, including absent/existing storage and failed-write verification. No runtime integration is claimed or added, consistent with the supplied plan. The already-fixed empty-update rejection remains covered by both validators' tests.

Current-revision verification:

| Check | Result |
| --- | --- |
| `npm run build:core` | Passed. |
| Both compiled notes contract test files | 9 passed, 0 failed. |
| `npm run test:core` | Approved run passed: 1,811 total, 1,809 passed, 2 skipped, 0 failed. Sandbox run failed: 27 failures with localhost EPERM and watcher EMFILE; no checks changed. |
| `npm run check-types` | Passed across all workspaces. |
| `npm run build:renderer` | Passed; existing chunk-size warning. |
| `npm run test:praxis-contracts` | Passed: 732 Playwright tests catalogued and linked. |
| Read-only `parsePlanFolder` before and after | Unchanged: 58 features, 184 stories, 408 tasks, 18 bugs (610 child items). |
| `git diff --check` | Passed. |

Plan metadata remains TASK-496 / Task / To Do / H1 `TASK-496: Define note and group contracts`: ID, explicit type, status, title and dependencies are unchanged, preserving the plan-authoring rules. No UI changes or visual verification were performed. No workflow definition, stage progression, tracker state or TASK-497 gates changed.

---

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

## Review recovery — TASK-496 contracts-only scope

Recovery base: `dac4f38a`. This section records current-revision evidence; the earlier verification table describes the initial implementation only.

1. **Empty update patches (bug): addressed.** Shared input validation now rejects empty objects with `VALIDATION_ERROR` and a safe root field issue. Both note and group update validators are covered. Title-only updates, body-only updates and explicit empty-body clearing remain valid; unknown/immutable-field rejection is preserved.
2. **Missing operational integration (quality): scope clarified, integration deferred.** Acceptance for TASK-496 is limited to shared types, pure validators/schema initialisation, detached snapshots and the future IPC declaration, as required by the supplied plan. Schema initialisation means `parseNotesDocument(undefined)` returns an independent empty version-one document without writes. IPC proof covers serialisable discriminated contracts and pure helper errors, not running handlers or failed disk writes. TASK-497 explicitly owns persistence, main/preload handlers, atomic saves, notifications and restart restoration; those application-path guarantees remain unverified here and are not claimed complete. No ticket acceptance or workflow gates were weakened or changed.

Current checks:
- `npm run build:core`: passed.
- Both compiled notes contract files: 9 passed, 0 failed.
- `npm run check-types`: passed across all workspaces.
- `npm run build:renderer`: passed; existing chunk-size warning remains.
- `npm run test:praxis-contracts`: passed, 732 Playwright tests catalogued.
- Initial full core run failed with sandbox localhost `EPERM` and watcher `EMFILE`; an approved run outside the sandbox was requested to execute these environment-dependent tests.

No UI change or visual verification was performed. Only validator implementation, its contract tests, and this required artifact changed. Persistence, handlers, preload, board/workspace data, scheduled runs and workflow definitions remain unchanged.
- Approved full `npm run test:core`: passed, 1,811 tests total; 1,809 passed, 2 skipped, 0 failed. This supersedes the sandbox run (1,782 passed, 27 failed, 2 skipped).
- `git diff --check`: passed before commit.
