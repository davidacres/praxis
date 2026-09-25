---
**Status:** In Progress
**Type:** Story
type: Story
id: FX-BE-056
title: "Browser diagnostics and repeatable verification"
status: Done
feature: FX-BF-022
updated: 2026-09-25
dependencies: [FX-BE-055]
---

# FX-BE-056: Browser diagnostics and repeatable verification

**Priority:** High
**Created:** 2026-09-07

## Outcome

Collect console errors, failed requests, screenshots and DOM evidence from managed previews and expose narrowly scoped tools to existing agent hosts.

## Scope and implementation entry points

main/src/main/aiBrowser.ts; packages/core/src/ai/tools/browserTools.ts; packages/core/src/ai/browserMcpServer.ts. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-055
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-147](tasks/task-147-capture-scoped-browser-evidence.md) | Capture scoped browser evidence |
| 2 | [TASK-148](tasks/task-148-expose-diagnostics-to-agents.md) | Expose diagnostics to agents |
| 3 | [TASK-149](tasks/task-149-add-preview-verification-workflow.md) | Add preview verification workflow |

## Acceptance criteria

- Seeded console error and failed API request appear in the correct run bundle; credentials and unrelated browser sessions do not enter attachments.
- Gateway and scripted ACP fixtures receive equivalent diagnostic records; unsupported capture is reported rather than invented.
- A fixture API/UI fault produces evidence, a fix produces fresh passing results, and screenshots are visually inspected; document that screenshots alone are not passing tests.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments



## Review 2026-09-25

Status corrected from In Progress → Done. Verified in the current tree:

- `packages/core/src/projects/browserDiagnostics.test.ts` exercises the
  browser diagnostics flow end-to-end in core.
- Preview verification: `previewVerification.ts` (+ test), and
  `apps/praxis-desktop/main/src/main/previewVerificationSession.ts` for the
  session side.
- Evidence wiring: `workflowEvidence.ts` carries diagnostics evidence.

Validation commands: `npm run check-types`, `npm run test:core`
(not rerun as part of this review).
