---
**Status:** ✅ Complete
**Created:** 2026-10-26
**Type:** Task
**Priority:** High
id: TASK-478
type: Task
status: To Do
priority: High
created: 2026-10-26
updated: 2026-10-26
feature: FX-BF-111
story: FX-BE-180
---

# TASK-478: Implement the durable sequential turn coordinator

Parent: [FX-BE-180](../story.md). Design: [FX-BF-111](../../../feature.md).

## Goal and scope

Create a core TeamChatCoordinator hosted by a main singleton. Inject repository, execution adapter, clock and ID source. Resolve mentions and roster in main; commit the response plan before dispatch. Enforce one active turn per conversation.

## Dependencies

TASK-477

## Acceptance criteria

- Two simultaneous sends produce distinct FIFO queued turns, while repeated delivery of one command produces one turn.
- Selected members answer in dev, qa, security, product, lead order; an explicit mention selects only that member; an empty roster resolves to lead.
- Later members see earlier committed replies from their turn; no member sees queued future user messages.
- Changing roster or runtime defaults affects subsequent accepted turns only; failures pause the current turn and leave later turns queued.

## Validation

Implement tests for each criterion above using the feature validation matrix and the owning core/main/renderer runner. Record the exact executed command, assertion names, results and failure artifacts. Register any new suite in the explicit npm test list. Use temporary profiles and repositories.

## Done when

All criteria pass with linked evidence, relevant feature commands pass, and the parent story and issue mirror record the result. Preserve unrelated WIP; do not claim unexecuted broad or real-provider checks.

## Description


## Comments


**PRX-T111-478** — 2026-11-05T15:47:05.859Z
**Workflow run failed: Governed delivery — TASK-478: Implement the durable sequential turn coordinator**

Status: Failed · Duration: 21s

- ❌ Plan: failed
- ⏳ Implement: pending
- ⏳ Praxis Test contracts: pending
- ⏳ Review: pending
- ⏳ Install dependencies: pending
- ⏳ Build: pending
- ⏳ QA: pending
- ⏳ Security scan: pending

Required stage "plan" failed.

**PRX-T111-478** — 2026-11-05T17:56:57.088Z
**Workflow run succeeded: Governed delivery — TASK-478: Implement the durable sequential turn coordinator**

Status: Succeeded · Duration: 2h 10m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Praxis Test contracts: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ✅ QA: succeeded
- ✅ Security scan: succeeded
## Scheduled delivery and verification ownership

Follow the parent feature's scheduled execution contract. The process runs this task's checks and performs visual inspection immediately when visible behavior changes, retaining useful screenshots. Human review is deferred until all twelve tasks are delivered. Record the prerequisite/result commits and evidence in the task handoff; do not execute against a base missing predecessor changes or bypass an approval gate to advance the queue.
