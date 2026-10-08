---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Story
**Priority:** High
id: FX-BE-164
type: Story
status: Backlog
created: 2026-10-08
priority: High
featureId: 108
---

# Independent verification and skeptic stages

## Impact

The agent that grades the work is not the agent that wrote it, and false findings are challenged before they send a loop round again.

## Scope

`stageModel.ts` / `workflowAgentStage.ts` (provider and model choice), `workflowTypes.ts` (node field), `workflowValidation.ts`, the designer's stage inspector, and a new bundled `praxis-skeptic` agent plus template wiring. Model ids stay provider-specific; the feature never hard-codes one.

## Acceptance criteria

- An agent stage may declare `independentOf: <nodeId>`. At launch the stage runs on a different provider than the named stage's attempt when another configured provider exists; otherwise a different model within the provider (by tier map); otherwise it runs and the run timeline records "not independent: only one model available" so nobody assumes otherwise.
- `independentOf` is validated (the node exists, is an agent stage, and is upstream), copied by `normalizeWorkflow`, and covered by the round-trip test.
- A skeptic stage pattern ships: a read-only `praxis-skeptic` agent whose only job is to try to refute a plan or a findings list and returns each finding as `confirmed` or `refuted` with evidence. Refuted findings are dropped (kept in the record as refuted) before a findings edge is evaluated.
- The independence decision is shown in the stage's session record and run timeline, with the reason.
- Switching provider mid-run (provider limit) never silently breaks independence; if it would, the run pauses for a decision rather than continuing as the author's own reviewer.
- The Governed delivery template uses `independentOf: implement` for Review and the security reviewer.

## Dependencies

FX-BE-162

## Description

Make reviewers independent of authors and add a refute-before-act stage.

## Comments
