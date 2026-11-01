# change-diff — PRX-T113-503

Base: `336ec028c5f9e5efc2c15baa783bceb22df7f149`.

## Scope

Evidence-only recovery for TASK-503. Replaces the stale dependency-blocked report with current build, guard, unit, focused/full UI, theme, geometry and partial visual evidence. Product code, tests, snapshots, plan and workflow definitions are unchanged.

Changed files:
- `.praxis/session-artifacts/task-503/validation-report.md`: exact results, failure diagnostics/classification, verification limits and preserved evidence references.
- `.praxis/change-diff.md`: required artifact for this stage, replacing unrelated TASK-496 artifact content.

## Verification outcome

Builds and type/import/contract guards pass. Renderer notes: 18 passed. Desktop unit suite: 107 passed with permitted localhost execution (sandbox: 103 passed / 4 EPERM failures). Focused UI: 32 passed / 7 failed / 2 skipped. Full UI: 706 passed / 9 failed / 14 skipped. Current folder gate: 15 passed. Theme/surface: 47 passed. No snapshots updated.

Two unrelated full-run failures were reproduced once individually. Notes shelf focus/project-picker and sidebar test-selector failures remain findings; this validation-only plan forbids product fixes. Actual-theme screenshot matrix is partial: two fresh PNGs inspected, remaining cases stopped after an absent-sleeve measurement error. Complete manual keyboard/pointer acceptance was not performed. Classic no longer exists in this revision.

## Recovery handling

The supplied abort has no diagnostic cause. Dependency preflight now passes; no dependencies installed/copied/linked. Tests reached completion instead of repeating the older missing-package report. Sandbox denial was handled through permitted execution without weakened checks. All unresolved findings and unrun checks remain explicit. Evidence is not a release-ready or green-gate claim.

The untracked `apps/praxis-desktop/main/e2e/zzTask503Capture.spec.ts` appeared separately and is left untouched and unstaged. Fresh PNGs/logs are retained locally under `.praxis/session-artifacts/task-503/`; only the report and this artifact are committed.
