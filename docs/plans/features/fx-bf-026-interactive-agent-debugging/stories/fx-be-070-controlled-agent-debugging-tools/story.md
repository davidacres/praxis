---
**Status:** 📋 Proposed
**Type:** Story
type: Story
id: FX-BE-070
title: "Controlled agent debugging tools"
status: To Do
feature: FX-BF-026
updated: 2026-09-07
dependencies: [FX-BE-069]
---

# FX-BE-070: Controlled agent debugging tools

**Priority:** High
**Created:** 2026-09-07

## Outcome

Let agents inspect and drive the same debugger service while users can observe and take control.

## Scope and implementation entry points

packages/core/src/ai; browser MCP pattern; main/src/main/debugging. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-069
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-189](tasks/task-189-expose-narrow-debug-tools.md) | Expose narrow debug tools |
| 2 | [TASK-190](tasks/task-190-separate-inspection-from-evaluation.md) | Separate inspection from evaluation |
| 3 | [TASK-191](tasks/task-191-connect-debugger-evidence-to-diagnosis.md) | Connect debugger evidence to diagnosis |

## Acceptance criteria

- Gateway and scripted ACP fixtures see equivalent events; read-only analysis cannot start or resume a process.
- Denied evaluation never reaches adapter; abort stops further agent actions; continued processes invalidate pending inspection references.
- Agent fixture identifies a seeded runtime-state defect, proposes a fix and yields independently passing tests; logs distinguish hypotheses from observed runtime state.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.

## Description


## Comments


