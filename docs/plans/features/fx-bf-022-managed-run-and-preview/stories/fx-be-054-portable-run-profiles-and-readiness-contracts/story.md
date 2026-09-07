---
type: Story
id: FX-BE-054
title: "Portable run profiles and readiness contracts"
status: planned
feature: FX-BF-022
updated: 2026-09-07
dependencies: [FX-BF-021]
---

# FX-BE-054: Portable run profiles and readiness contracts

**Priority:** High
**Created:** 2026-09-07

## Outcome

Describe frontend, API and dependent processes in a named project Run profile; keep ephemeral previews separate from deployment.

## Scope and implementation entry points

packages/core/src/projects; packages/core/src/host/ipcContracts.ts. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BF-021
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-141](tasks/task-141-define-run-profile-schema.md) | Define run profile schema |
| 2 | [TASK-142](tasks/task-142-resolve-launch-configuration.md) | Resolve launch configuration |
| 3 | [TASK-143](tasks/task-143-build-project-run-profile-editor.md) | Build project Run profile editor |

## Acceptance criteria

- Profiles round-trip with repo-relative paths; duplicate service IDs, dependency cycles, invalid probes and embedded secrets are rejected.
- Fixtures cover Node frontend, ASP.NET API and multiple services; no detected script or launch settings file is executed during discovery.
- Profiles remain project-owned with any tracker backend; keyboard, theme and responsive captures show the profile editor and invalid inputs.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.
