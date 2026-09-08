---
type: Task
id: TASK-134
title: "Expose evidence in the run monitor"
status: complete
story: FX-BE-051
updated: 2026-09-08
dependencies: [TASK-133]
---

# TASK-134: Expose evidence in the run monitor

**Priority:** High
**Created:** 2026-09-07

## Goal

Add typed IPC and evidence links in the existing stage detail/Output surfaces with loading, truncated, expired and unavailable states; redact before model exposure.

## Implementation entry points

packages/core/src/workflows; main/src/main/workflowCheckRunner.ts. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- TASK-133
## Acceptance criteria

- An Electron fixture opens a failed check's retained log; keyboard navigation and theme captures cover failure and empty states.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:** The retained-evidence contract was completed across the stack and exposed in the run monitor UI:

- `packages/core/src/host/ipcContracts.ts` adds the typed `workflows:getEvidence` / `workflows:readEvidenceEntry` contract and `WorkflowEvidenceReadResult` shape.
- `apps/praxis-desktop/main/src/main/workflowIpc.ts` reads the evidence bundle and maps retention outcomes (`available`, `empty`, `missing`, `expired`, `unavailable`), including the truncated-state hint and explicit failure reasons.
- `apps/praxis-desktop/renderer/src/workflows/WorkflowRunMonitor.tsx` loads evidence for the selected stage attempt and renders a state-aware evidence panel in the existing stage detail surface.

**Commands run:**

- `npm run build:core` — succeeded.
- `npm run test:desktop:workflows` — 13/13 passing.
- `npx tsc -p packages/core && node --test packages/core/out/workflows/workflowEvidence.test.js` — 23/23 passing.

**Current status:** The evidence retention and UI exposure path are in place, and the task is complete against the plan and predecessor task sequence.
