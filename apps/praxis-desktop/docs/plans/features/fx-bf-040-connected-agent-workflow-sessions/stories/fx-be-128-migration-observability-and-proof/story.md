---
id: FX-BE-128
title: Migration, observability, compatibility, and end-to-end proof
status: Planned
feature: FX-BF-040
issue: docs/issues/features/fx-bf-040-connected-agent-workflow-sessions/stories/fx-be-128-migration-observability-and-proof/issue.md
updated: 2026-09-17
tasks: [TASK-350, TASK-351, TASK-352]
dependencies: [FX-BE-123, FX-BE-124, FX-BE-125, FX-BE-126, FX-BE-127]
validation: [npm run check-types, npm run build:core, npm run build:renderer, npm run build:desktop, npm run test:core, npm run test:desktop]
---

# Migration, observability, compatibility, and end-to-end proof

Parent feature folder: `fx-bf-040-connected-agent-workflow-sessions`

## User or operational impact

The connected model can ship without invalidating existing sessions, manifests,
packs, or project data, and operators can diagnose whether a failure occurred
in selection, binding, host transport, skill activation, orchestration, a gate,
or the provider.

## Scope

- Version and migrate persisted session, binding, workflow, pack, and run
  records with explicit legacy behavior.
- Add redacted lifecycle diagnostics and audit events across selection, launch,
  stage, artifact, gate, approval, and recovery transitions.
- Prove the vertical slice with deterministic fixtures and one real local host,
  then document unsupported transports and rollout boundaries.

## Acceptance criteria

- Existing sessions and legacy manifests open; prompt-only packs remain
  prompt-only unless explicitly promoted or selected as a governed workflow.
- Every connected run can answer: which definition version, profile, host,
  provider, skills, activation modes, tool mode, folder, node, artifacts, and
  policy decisions were used.
- A deterministic full path covers session selection, real host launch, skill
  context, stage scheduling, artifact handoff, blocked approval, approval,
  completion, and reopen-after-restart.
- Unsupported or scaffold-only adapters are visible as unavailable rather than
  appearing ready.

## Task list

- `TASK-350` — Define migrations and compatibility behavior for legacy records.
- `TASK-351` — Add redacted lifecycle diagnostics, audit events, and support docs.
- `TASK-352` — Add deterministic fixtures, real-host vertical E2E, and final verification.

## Validation

- Full desktop/core validation listed in the feature frontmatter.
- Migration fixtures and restart/reopen E2E.

## Close when

The connected model is observable and backward-compatible, and the complete
session-to-run-to-gate journey is proven in automated tests and documented for
unsupported cases.
