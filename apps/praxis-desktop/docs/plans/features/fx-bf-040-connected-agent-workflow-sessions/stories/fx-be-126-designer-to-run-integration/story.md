---
id: FX-BE-126
title: Workflow Designer and Task Designer integration
status: Planned
feature: FX-BF-040
issue: docs/issues/features/fx-bf-040-connected-agent-workflow-sessions/stories/fx-be-126-designer-to-run-integration/issue.md
updated: 2026-09-17
tasks: [TASK-344, TASK-345, TASK-346]
dependencies: [FX-BF-012, FX-BF-014, FX-BF-015, FX-BF-017]
validation: [npm run check-types, npm run build:renderer, npm run build:desktop, npm run test:desktop]
---

# Workflow Designer and Task Designer integration

Parent feature folder: `fx-bf-040-connected-agent-workflow-sessions`

## User or operational impact

Designers have a clear handoff into execution. Workflow Designer authors the
executable governed graph; Task Designer remains the planning surface but can
explicitly promote a plan into a workflow input or start a run from it.

## Scope

- Show real Agent Hub binding readiness and gate/policy impact in Workflow
  Designer before save/run.
- Add an explicit Task Designer “promote/use as workflow input” path that
  preserves the planning artifact and creates a governed run only after review.
- Add navigable links among task, controller session, workflow definition, run,
  stage session, and evidence.

## Acceptance criteria

- Workflow Designer can configure profile, host, provider, skills, tool mode,
  checks, artifacts, and gates against the same preflight used at runtime.
- Task Designer never silently becomes a workflow graph; promotion is explicit,
  reports what was mapped, and leaves the master plan intact.
- A run started from either designer lands in the same Run Monitor and session
  history as a run started from New Session.
- All designer states include unavailable dependency, no-folder, invalid graph,
  and policy-blocked feedback.

## Task list

- `TASK-344` — Share runtime readiness and dependency contracts with Workflow Designer.
- `TASK-345` — Add explicit Task Designer plan-to-workflow input/promotion flow.
- `TASK-346` — Add cross-surface navigation and run/session provenance.

## Validation

- Renderer type/build checks.
- Desktop E2E for author → promote/use plan → start → inspect run/session.

## Close when

Both designers produce or feed the same governed run model with explicit user
intent and durable provenance.
