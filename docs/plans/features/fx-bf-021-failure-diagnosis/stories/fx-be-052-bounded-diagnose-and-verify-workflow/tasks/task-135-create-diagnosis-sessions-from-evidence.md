---
type: Task
id: TASK-135
title: "Create diagnosis sessions from evidence"
status: complete
story: FX-BE-052
updated: 2026-09-09
dependencies: [FX-BE-051]
---

# TASK-135: Create diagnosis sessions from evidence

**Priority:** High
**Created:** 2026-09-07

## Goal

Construct a structured brief with source SHA, environment, command and evidence references; preflight tool access and repository availability; do not run pasted log content as commands.

## Implementation entry points

packages/core/src/ai; packages/core/src/workflows; renderer/src/ai. Paths prefixed main/src or renderer/src are under apps/praxis-desktop; verify current ownership before editing.

## Dependencies

- FX-BE-051
## Acceptance criteria

- A scripted ACP fixture receives the intended revision and evidence; folderless and read-only sessions explain why repair cannot start.
- The implementation satisfies the parent story's outcome and preserves existing unrelated workflows.

## Verification

Use deterministic fixtures for the named acceptance scenarios. Run focused core tests and type checks for changed contracts; build the affected workspaces for IPC/UI changes. For UI changes, rebuild/copy the renderer, run the relevant Electron specs and inspect captures across theme axes, narrow layouts and keyboard focus. Prove regression guards fail against the broken behaviour. Paid live-agent and real infrastructure tests remain explicit opt-ins and use disposable targets. Never point a Praxis write path at the repository's own plans.

## Completion evidence

**Implemented:** The diagnosis brief and repair-session preflight are in place.

- `packages/core/src/workflows/workflowStageTask.ts` adds `buildDiagnosisTaskDefinition` / `buildDiagnosisBrief` and `diagnoseSessionPreflight`, grounding the task in the retained revision, environment, command and evidence references and refusing folderless / read-only repair attempts with explicit reasons.
- `packages/core/src/workflows/workflowStageTask.test.ts` covers the evidence-grounded brief and the folderless/read-only block cases.

**Commands run:**

- `node --test packages/core/src/workflows/workflowStageTask.test.ts` — passed.

**Current status:** The repo-backed diagnosis brief and repair-session guard are implemented on the branch; the remaining bounded-repair and verification UI tasks in this story are still outstanding.
