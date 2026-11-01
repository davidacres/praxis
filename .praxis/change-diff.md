# change-diff — PRX-T113-503

Base: `336ec028` (product revision under test). History since then: `01b22d6b` (a concurrent session's
partial report) and `a81aab04` (workflow auto-commit that swept in a throwaway capture spec).

## Scope

Evidence only for TASK-503. No product code, spec, snapshot, setting or workflow definition is changed.

Changed files:
- `.praxis/session-artifacts/task-503/validation-report.md` — full validation results: builds, guards,
  unit, focused/full functional and theme suites, failure classification, rail measurement matrix,
  inspected screenshots, journeys, observations and unrun checks.
- `.praxis/change-diff.md` — this artifact.
- `apps/praxis-desktop/main/e2e/zzTask503Capture.spec.ts` — **deleted**. A throwaway capture script
  that `a81aab04` committed by accident; leaving it would add it to every functional run.

## Verification outcome

- All four builds, `check-types`, core-import guard and contracts catalogue pass.
- Unit tests: renderer 18/18, `test:desktop:git` 107/107.
- Theme suites: 47 passed, no snapshot changes. Folder gate: 15 passed (the documented 13 is stale).
- Full functional suite: 706 passed / 10 failed / 13 skipped. After isolated re-runs and probes:
  - **one product defect:** keyboard Enter on the shelf pencil leaves focus on the pencil, not the note title (`sessionShelfNotes:96`).
  - four spec selector/reload defects (`sessionShelfNotes:66/:107`, `sidebarNotes:41/:83`).
  - two specs made stale by FX-BF-113 layout (`sessionShelf:51` spine centring, `easymode:1377` tab order; the divider label needs an owner decision).
  - one environment test (`marketplace:271`) and three flaky tests (`aiPermissions:36`, `themeAccent:33`, `sessionShelf:306`).
- Rail: 14.00 px at scale 1, 16.23 px at 1.16, and identical to the no-controls baseline with an unchanged 4 px inset. This holds in light/dark, Parchment/Aurora Glass/Graphite, at 110% zoom and at 720 px, empty and full, with the sleeve open and closed. The sleeve is flush and there is no horizontal overflow.

The UI gate is **not green**. The product defect and the spec fixes are follow-up work, outside this validation-only task.
