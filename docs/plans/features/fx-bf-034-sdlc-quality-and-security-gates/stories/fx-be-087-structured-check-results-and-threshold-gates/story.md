---
type: Story
id: FX-BE-087
title: "Structured check results and threshold gates"
status: planned
feature: FX-BF-034
updated: 2026-09-09
dependencies: [FX-BE-020, FX-BE-024]
---

# FX-BE-087: Structured check results and threshold gates

**Priority:** High
**Created:** 2026-09-09

## Outcome

Give check nodes a structured result: a closed `findings` artifact kind holding normalised `findings[]` (stable fingerprint, file, line, severity, category, message, optional suggestion) and `metrics{}` (named numbers). Adapters normalise SARIF, JUnit, lcov/Cobertura, `npm audit --json` and `osv-scanner` JSON into it. A gate condition may then read `metrics.<name> >= n` or `findings(severity >= <level>).count == 0`, evaluated by the engine and composed strictest-wins. The run monitor shows findings grouped by severity, each linked to its file and evidence entry.

## Scope and implementation entry points

packages/core/src/workflows (`workflowTypes.ts`, `workflowGates.ts`, `workflowValidation.ts`, `workflowRun.ts`); apps/praxis-desktop/main/src/main/workflowCheckRunner.ts; apps/praxis-desktop/renderer/src/workflows (run monitor). Keep adapters pure and unit-testable; attach them where the check runner already captures output through the redacting evidence store.

## Dependencies

- FX-BE-020
- FX-BE-024
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-237](tasks/task-237-define-check-findings-contract-and-artifact-kind.md) | Define the CheckFindings contract and the findings artifact kind |
| 2 | [TASK-238](tasks/task-238-add-result-format-adapters.md) | Add SARIF / JUnit / lcov / npm-audit / osv-scanner adapters |
| 3 | [TASK-239](tasks/task-239-add-metric-and-severity-threshold-gates.md) | Add metric and severity threshold gate policy |
| 4 | [TASK-240](tasks/task-240-render-findings-and-metrics-in-the-run-monitor.md) | Render findings and metrics in the run monitor |

## Acceptance criteria

- A `findings` artifact round-trips through the run: a check node declaring it, a downstream gate consuming it, and the run summary listing its findings and metrics. Fingerprints are stable across two runs of the same unchanged issue.
- Each adapter maps real captured tool output (checked-in fixtures) to `CheckFindings`; a malformed or unrecognised report fails the node with a stated reason and never passes as empty findings.
- A threshold gate blocks approval when the metric is under the bar or a finding is at/above the level, and passes when it is not; a project can tighten the org threshold but a compose that would loosen it is refused by validation.
- The run monitor groups findings by severity, links each to its file/line and its evidence entry, and shows named metrics; verified across theme axes, narrow layout and keyboard focus.
- All child tasks have implementation and verification evidence; no child is complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a full story journey with a real scanner's captured SARIF driving a real threshold gate. Focused core tests and type checks for the changed contracts; build the affected workspaces for IPC/UI changes; rebuild and copy the renderer before focused Electron specs and inspect captures. Prove each new gate/adapter guard fails against the pre-change behaviour. Update the feature-parity doc and user guide when the capability ships.

## Exclusions

No new results store, no raw tool-format parsing downstream of the adapters, no automatic scanner selection (that is FX-BE-088), and no change to how agent stages satisfy the `review` gate here.
