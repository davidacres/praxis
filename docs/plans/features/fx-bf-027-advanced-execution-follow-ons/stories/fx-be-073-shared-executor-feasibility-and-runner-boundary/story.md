---
type: Story
id: FX-BE-073
title: "Shared executor feasibility and runner boundary"
status: backlog
feature: FX-BF-027
updated: 2026-09-07
dependencies: [FX-BE-072]
---

# FX-BE-073: Shared executor feasibility and runner boundary

**Priority:** Low
**Created:** 2026-09-07

## Outcome

Evaluate shared execution for long-running work and internal targets without making the desktop an implicit always-on CI server.

## Scope and implementation entry points

packages/core/src/deployments; architecture documentation. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BE-072
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-198](tasks/task-198-define-runner-trust-and-capability-contract.md) | Define runner trust and capability contract |
| 2 | [TASK-199](tasks/task-199-prototype-one-controlled-remote-execution-path.md) | Prototype one controlled remote execution path |
| 3 | [TASK-200](tasks/task-200-record-rollout-decision-and-remaining-work.md) | Record rollout decision and remaining work |

## Acceptance criteria

- Threat/failure review covers wrong-project jobs, expired credentials, digest mismatch and runner loss; no arbitrary unauthenticated execution endpoint.
- Network loss does not imply job failure or cause duplicate deployment; record operational owner, costs and supported platform assumptions.
- Existing local and CI paths remain sufficient and supported; remote production support is not advertised from a prototype.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.
