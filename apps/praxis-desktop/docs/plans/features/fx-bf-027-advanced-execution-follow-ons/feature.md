---
**Status:** To Do
**Type:** Feature
type: Feature
id: FX-BF-027
title: "Deferred execution reliability and automation extensions"
status: To Do
slug: advanced-execution-follow-ons
stories: [FX-BE-071, FX-BE-072, FX-BE-073]
issues: docs/issues/features/fx-bf-027-advanced-execution-follow-ons/feature-issues.md
updated: 2026-09-07
dependencies: [FX-BF-024, FX-BF-026]
---

# FX-BF-027: Deferred execution reliability and automation extensions

**Priority:** Low
**Created:** 2026-09-07

## Outcome

Explicitly deferred follow-ons: capability-led provider integration, bounded event automation and shared execution. These do not block diagnosis, publishing or interactive debugger milestones.

## Delivery priority

Deferred follow-on. Do not start until core milestones are complete and the bounded feasibility stories justify further implementation.

## Dependencies

- FX-BF-024
- FX-BF-026
## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-071](stories/fx-be-071-capability-led-session-recovery-and-cost-attribution/story.md) | Capability-led session recovery and cost attribution |
| 2 | [FX-BE-072](stories/fx-be-072-event-triggered-bounded-failure-repair/story.md) | Event-triggered bounded failure repair |
| 3 | [FX-BE-073](stories/fx-be-073-shared-executor-feasibility-and-runner-boundary/story.md) | Shared executor feasibility and runner boundary |

## Implementation boundaries

Shared domain logic belongs in core; Electron main owns processes, filesystem, credentials and privileged IPC. Renderer imports core types only. Reuse the current workflow engine, Agent Hub and themed in-app dialogs. Project issue backend must not determine deployment executor or target. Files created by the application follow `<name>.praxis.<ext>` with shared filename constants; plan documents retain this repository's established feature/story/task names.

## Close when

Every story and child task is implemented and verified; required integrations have fixture evidence and any real-runtime proof is documented. The feature is a completion roll-up, not a prerequisite for its own children. Planned dependencies are prerequisites to start; containment is recorded through feature/story metadata.

## Verification

Review the complete feature journey and documented support matrix. Follow AGENTS.md for core boundaries, source schema inspection, UI verification and temporary fixtures. Do not claim production support from mocked integration tests alone.

## Description

---
**Status:** To Do
**Type:** Feature
type: Feature
id: FX-BF-027
title: "Deferred execution reliability and automation extensions"
status: To Do
slug: advanced-execution-follow-ons
stories: [FX-BE-071, FX-BE-072, FX-BE-073]
issues: docs/issues/features/fx-bf-027-advanced-execution-follow-ons/feature-issues.md
updated: 2026-09-07
dependencies: [FX-BF-024, FX-BF-026]
---

# FX-BF-027: Deferred execution reliability and automation extensions

**Priority:** Low
**Created:** 2026-09-07

## Outcome

Explicitly deferred follow-ons: capability-led provider integration, bounded event automation and shared execution. These do not block diagnosis, publishing or interactive debugger milestones.

## Delivery priority

Deferred follow-on. Work may start only after FX-BF-024 and FX-BF-026 are complete and their required interfaces are available; no additional unnamed core-milestone gate applies. The bounded feasibility stories must still justify further implementation.

## Dependencies

- FX-BF-024
- FX-BF-026

## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-071](stories/fx-be-071-capability-led-session-recovery-and-cost-attribution/story.md) | Capability-led session recovery and cost attribution |
| 2 | [FX-BE-072](stories/fx-be-072-event-triggered-bounded-failure-repair/story.md) | Event-triggered bounded failure repair |
| 3 | [FX-BE-073](stories/fx-be-073-shared-executor-feasibility-and-runner-boundary/story.md) | Shared executor feasibility and runner boundary |

## Implementation boundaries

Shared domain logic belongs in core; Electron main owns processes, filesystem, credentials and privileged IPC. Renderer imports core types only. Reuse the current workflow engine, Agent Hub and themed in-app dialogs. Project issue backend must not determine deployment executor or target. Files created by the application follow `<name>.praxis.<ext>` with shared filename constants; plan documents retain this repository's established feature/story/task names.

## Acceptance criteria

- [ ] FX-BE-071 provides recovery and cost-attribution evidence.
- [ ] FX-BE-072 provides bounded-event and failure-stop evidence.
- [ ] FX-BE-073 records its feasibility decision and resulting runner boundary.

## Close when

Each ordered story has completed its agreed outcome and tests; integrations have fixture evidence for scoped capabilities; FX-BE-073 records whether a shared executor proceeds, defers, or is rejected.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


