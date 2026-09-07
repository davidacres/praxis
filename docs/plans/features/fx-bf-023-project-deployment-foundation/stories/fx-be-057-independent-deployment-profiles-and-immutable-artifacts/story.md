---
type: Story
id: FX-BE-057
title: "Independent deployment profiles and immutable artifacts"
status: planned
feature: FX-BF-023
updated: 2026-09-07
dependencies: [FX-BF-021]
---

# FX-BE-057: Independent deployment profiles and immutable artifacts

**Priority:** High
**Created:** 2026-09-07

## Outcome

Define named project-owned profiles independently of Jira, GitHub, GitLab or folder issue storage; separate publishing an artifact from installing it.

## Scope and implementation entry points

packages/core/src/projects; packages/core/src/workflows; packages/core/src/host/secrets.ts. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BF-021
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-150](tasks/task-150-define-deployment-domain-contracts.md) | Define deployment domain contracts |
| 2 | [TASK-151](tasks/task-151-persist-portable-profiles-and-references.md) | Persist portable profiles and references |
| 3 | [TASK-152](tasks/task-152-separate-publish-from-deploy.md) | Separate publish from deploy |

## Acceptance criteria

- Schema tests accept Jira plus GitHub Actions plus IIS, and folder plus local process plus directory; unsupported executor/target capabilities fail preflight.
- Export/open on another machine rebinds local destinations and secrets explicitly; plaintext credentials never appear in committed profile fixtures.
- A .NET publish directory and a web artifact both validate; absent or modified artifacts fail; existing MSI configuration remains understandable and is never silently reinterpreted.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.
