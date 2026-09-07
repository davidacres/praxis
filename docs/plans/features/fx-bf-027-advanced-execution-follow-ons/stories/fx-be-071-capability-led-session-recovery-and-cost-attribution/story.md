---
type: Story
id: FX-BE-071
title: "Capability-led session recovery and cost attribution"
status: backlog
feature: FX-BF-027
updated: 2026-09-07
dependencies: [FX-BF-024, FX-BF-026]
---

# FX-BE-071: Capability-led session recovery and cost attribution

**Priority:** Low
**Created:** 2026-09-07

## Outcome

Assess current ACP schema before adding provider-specific integration; improve interruption visibility and report only provider-supplied usage/cost.

## Scope and implementation entry points

packages/core/src/ai/acp; packages/core/src/ai/aiSessionManager.ts. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BF-024
- FX-BF-026
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-192](tasks/task-192-audit-supported-agent-protocol-capabilities.md) | Audit supported agent protocol capabilities |
| 2 | [TASK-193](tasks/task-193-prototype-optional-codex-app-server-adapter.md) | Prototype optional Codex App Server adapter |
| 3 | [TASK-194](tasks/task-194-add-recovery-and-attempt-level-usage-presentation.md) | Add recovery and attempt-level usage presentation |

## Acceptance criteria

- Document actual handled/unhandled capabilities and unstable fields; do not classify an unhandled stable event as unsupported by ACP.
- No production dependency or replacement of ACP until version/support contract and regression fixtures justify it; prototype failure leaves existing hosts unchanged.
- Fixtures with missing costs, mixed currencies and resumed sessions never invent credits or double-count cumulative provider reports.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.
