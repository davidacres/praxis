---
id: FX-BE-125
title: Workflow packs and skill activation inside governed stages
status: Planned
feature: FX-BF-040
issue: docs/issues/features/fx-bf-040-connected-agent-workflow-sessions/stories/fx-be-125-workflow-packs-and-skill-activation/issue.md
updated: 2026-09-17
tasks: [TASK-341, TASK-342, TASK-343]
dependencies: [FX-BF-010, FX-BF-011, FX-BF-012, FX-BF-038]
validation: [npm run check-types, npm run build:core, npm run test:core, npm run test:desktop]
---

# Workflow packs and skill activation inside governed stages

Parent feature folder: `fx-bf-040-connected-agent-workflow-sessions`

## User or operational impact

Skills and workflow packs become inspectable inputs to the stage that uses them,
while the product keeps a clear distinction: a skill is a reusable capability;
a workflow is the governed sequence that composes stages and gates.

## Scope

- Resolve `workflowPackId` when building a governed agent stage and include its
  instructions and provenance in the stage context.
- Compile selected skills through native/tool/context fallback and persist the
  activation mode actually achieved.
- Define how legacy issue-level workflow packs map to recommended/default
  workflow metadata without silently starting a governed run.

## Acceptance criteria

- A stage with a workflow pack receives the pack content or a verified bounded
  reference, and the run records the pack version/source used.
- Every selected skill has a truthful activation result: native only when the
  host confirms it, otherwise an explicit tools or context fallback.
- The same skill cannot be activated outside its scope or trust boundary, and
  a missing/incompatible skill blocks only the stage/run that requires it.
- Legacy prompt-only sessions remain readable and do not gain gates or
  orchestration without an explicit workflow selection.

## Task list

- `TASK-341` — Resolve workflow packs into stage task context and provenance.
- `TASK-342` — Compile skill activation and record native/tool/context outcomes.
- `TASK-343` — Migrate legacy issue workflow-pack assignments safely.

## Validation

- Core resolver and activation-mode tests.
- Desktop E2E showing pack/skill provenance on a stage and unchanged legacy
  prompt-only behavior.

## Close when

Workflow and skill inputs are visible, versioned, and enforced at the stage
boundary without presenting either one as the other.
