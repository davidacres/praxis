---
type: Story
id: FX-BE-064
title: "IIS capability preflight and target configuration"
status: planned
feature: FX-BF-025
updated: 2026-09-07
dependencies: [FX-BF-023]
---

# FX-BE-064: IIS capability preflight and target configuration

**Priority:** High
**Created:** 2026-09-07

## Outcome

Resolve site, application, pool, destination and health endpoint without changing the server during discovery.

## Scope and implementation entry points

packages/core/src/deployments; main/src/main; renderer/src/deployments. Main and renderer paths are relative to apps/praxis-desktop. Keep provider-specific code behind capability-aware adapters.

## Dependencies

- FX-BF-023
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-171](tasks/task-171-define-iis-target-and-prerequisites.md) | Define IIS target and prerequisites |
| 2 | [TASK-172](tasks/task-172-validate-target-boundaries-and-credentials.md) | Validate target boundaries and credentials |
| 3 | [TASK-173](tasks/task-173-build-iis-profile-template.md) | Build IIS profile template |

## Acceptance criteria

- Non-Windows local execution yields a clear unsupported result while a pipeline-backed Windows target remains configurable; discovery makes no IIS mutations.
- Missing rights, locked paths and mismatched site/application block preparation with actionable diagnostics; secrets are redacted from evidence.
- An existing IIS test site can be selected explicitly; no site is created, deleted or rebound implicitly.
- All child tasks have implementation and verification evidence; no child is marked complete merely because the plan was committed.

## Verification

Run the child-task fixture scenarios and a complete story journey. Use scripted ACP/DAP or provider fixtures by default. UI work includes build, renderer copy, focused Electron tests, inspected captures and keyboard/theme verification. Update the relevant user guide and feature-parity documentation when the capability ships.

## Exclusions

No automatic production deployment, broad credential grant, full source editor or replacement of the existing agent hosts is implied by this story. Unsupported capabilities must remain explicit.
