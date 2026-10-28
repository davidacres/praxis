---
**Status:** To Do
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-480
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-181
---

# TASK-480: Connect API and ACP execution through typed bindings

Parent: [FX-BE-181](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Adapt agentSessionLauncher, AiSessionManager and the existing assistant completion path behind the coordinator execution contract. Remove synthetic ticket-review framing from durable chat prompts. Resolve effective provider configuration before computing compatibility.

## Dependencies

TASK-479

## Acceptance criteria

- Two turns for two compatible tool-using members create four attempts and reuse two provider sessions; another chat shares none.
- A no-tools API member can complete without allocating an AgentSessionRecord; its attempt, result and reported usage remain attributable.
- Changing provider/account endpoint, model, prompt version, folder, tool mode or permissions invalidates the binding; missing native resume capability uses reconstruction.
- Revoked permissions cannot be recovered by selecting an old binding; current policy is revalidated before every dispatch and tool access remains behind existing gates.
- Provider-reported usage is attributed once per attempt; context occupancy is never counted as cumulative spend.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Description


## Comments

## Scheduled delivery and verification ownership

Follow the parent feature's scheduled execution contract. The process runs this task's checks and performs visual inspection immediately when visible behavior changes, retaining useful screenshots. Human review is deferred until all twelve tasks are delivered. Record the prerequisite/result commits and evidence in the task handoff; do not execute against a base missing predecessor changes or bypass an approval gate to advance the queue.
