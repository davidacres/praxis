# FX-BF-111 plan readiness and parser evidence

Plan authored and validated on 2026-10-26. Status: ready to start TASK-476; dependent tasks wait for their named predecessors. This report validates planning artifacts, not application behavior. No implementation source files, live conversations or provider sessions were changed by plan authoring. Existing dirty runtime/test files were preserved.

## Parser evidence

Used the existing compiled `packages/core/out/folder/markdownPlanParser.js` directly with `parsePlanFolder(path.resolve('docs/plans'))` from `apps/praxis-desktop`; this avoids FolderService write/upgrade behavior.

| Record type | Before | After | Added |
| --- | --- | --- | --- |
| features | 55 | 56 | 1 |
| stories | 170 | 176 | 6 |
| tasks | 380 | 392 | 12 |
| children | 568 | 586 | 18 |

`children` includes stories, tasks and other child types; it is not a task count. All 19 added IDs occur exactly once, resolve to feature 111, have the expected type, H1 and To Do status. Existing unrelated legacy parser collisions were not changed.

## Board-file inventory and rule compliance

Every row below satisfies rule 1 (real H1), rule 2 (explicit type, plus canonical feature filename), rule 3 (unique parsed planning ID), rule 4 (declared board status To Do), rule 5 (Dependencies section), and rule 6 (canonical feature/story/task layout). All task and story criteria are explicit; each story links its local issue mirror. The H1 column is the exact parsed title.

| ID | Type | Status | H1 | File |
| --- | --- | --- | --- | --- |
| FX-BF-111 | Feature | To Do | FX-BF-111: Durable team-chat conversations | [plan](../plans/features/fx-bf-111-durable-team-chat/feature.md) |
| TASK-476 | Task | To Do | TASK-476: Define typed conversation, turn, attempt, and binding contracts | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-179-durable-conversation-store/tasks/task-476-conversation-contracts.md) |
| TASK-477 | Task | To Do | TASK-477: Implement serialized durable conversation transactions | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-179-durable-conversation-store/tasks/task-477-atomic-chat-repository.md) |
| FX-BE-179 | Story | To Do | FX-BE-179: Durable conversation contracts and atomic storage | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-179-durable-conversation-store/story.md) |
| TASK-478 | Task | To Do | TASK-478: Implement the durable sequential turn coordinator | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-180-main-owned-coordinator/tasks/task-478-turn-coordinator.md) |
| TASK-479 | Task | To Do | TASK-479: Expose validated commands and revisioned conversation updates | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-180-main-owned-coordinator/tasks/task-479-command-and-event-ipc.md) |
| FX-BE-180 | Story | To Do | FX-BE-180: Main-owned turn scheduling and command delivery | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-180-main-owned-coordinator/story.md) |
| TASK-480 | Task | To Do | TASK-480: Connect API and ACP execution through typed bindings | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-181-provider-binding-and-context/tasks/task-480-execution-adapter.md) |
| TASK-481 | Task | To Do | TASK-481: Build versioned context with delivery receipts and summaries | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-181-provider-binding-and-context/tasks/task-481-context-delivery.md) |
| FX-BE-181 | Story | To Do | FX-BE-181: Explicit provider bindings and bounded context delivery | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-181-provider-binding-and-context/story.md) |
| TASK-482 | Task | To Do | TASK-482: Reconcile interrupted attempts and uncertain tool outcomes | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-182-interruption-and-recovery/tasks/task-482-recovery-reconciliation.md) |
| TASK-483 | Task | To Do | TASK-483: Implement safe cancellation, retry, and approval restoration | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-182-interruption-and-recovery/tasks/task-483-cancel-retry-permissions.md) |
| FX-BE-182 | Story | To Do | FX-BE-182: Interruption, cancellation, and tool-outcome recovery | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-182-interruption-and-recovery/story.md) |
| TASK-484 | Task | To Do | TASK-484: Make the assistant UI a conversation command client | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-183-renderer-and-migration/tasks/task-484-conversation-ui.md) |
| TASK-485 | Task | To Do | TASK-485: Migrate existing chats and stage the durable-writer cutover | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-183-renderer-and-migration/tasks/task-485-legacy-migration.md) |
| FX-BE-183 | Story | To Do | FX-BE-183: Renderer subscription, single navigation entry, and legacy migration | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-183-renderer-and-migration/story.md) |
| TASK-486 | Task | To Do | TASK-486: Complete deterministic crash and provider contract coverage | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-184-release-proof/tasks/task-486-failure-matrix-tests.md) |
| TASK-487 | Task | To Do | TASK-487: Verify built desktop UI and record release evidence | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-184-release-proof/tasks/task-487-desktop-release-verification.md) |
| FX-BE-184 | Story | To Do | FX-BE-184: Durable team-chat release verification | [plan](../plans/features/fx-bf-111-durable-team-chat/stories/fx-be-184-release-proof/story.md) |

## Other files written

| File | Purpose / identity |
| --- | --- |
| [feature-issues.md](../issues/features/fx-bf-111-durable-team-chat/feature-issues.md) | FX-BF-111: Durable team-chat conversations; local issue mirror, To Do |
| [issue.md](../issues/features/fx-bf-111-durable-team-chat/stories/fx-be-179-durable-conversation-store/issue.md) | FX-BE-179: Durable conversation contracts and atomic storage; local issue mirror, To Do |
| [issue.md](../issues/features/fx-bf-111-durable-team-chat/stories/fx-be-180-main-owned-coordinator/issue.md) | FX-BE-180: Main-owned turn scheduling and command delivery; local issue mirror, To Do |
| [issue.md](../issues/features/fx-bf-111-durable-team-chat/stories/fx-be-181-provider-binding-and-context/issue.md) | FX-BE-181: Explicit provider bindings and bounded context delivery; local issue mirror, To Do |
| [issue.md](../issues/features/fx-bf-111-durable-team-chat/stories/fx-be-182-interruption-and-recovery/issue.md) | FX-BE-182: Interruption, cancellation, and tool-outcome recovery; local issue mirror, To Do |
| [issue.md](../issues/features/fx-bf-111-durable-team-chat/stories/fx-be-183-renderer-and-migration/issue.md) | FX-BE-183: Renderer subscription, single navigation entry, and legacy migration; local issue mirror, To Do |
| [issue.md](../issues/features/fx-bf-111-durable-team-chat/stories/fx-be-184-release-proof/issue.md) | FX-BE-184: Durable team-chat release verification; local issue mirror, To Do |
| [PLAN_MAP.md](../PLAN_MAP.md) | 19 feature/story/task index rows |
| [index.md](../issues/index.md) | 7 local feature/story issue index rows |

This readiness report is an additional planning artifact outside the parsed plans tree; it creates no board card. Issue mirrors are also outside that tree and do not duplicate planning IDs on the board. No messages or remote issues were published.

## Validation results

- Parser assertions: exact +1 feature, +6 stories, +12 tasks; all new planning IDs/type/status/title/parent associations passed.
- Local Markdown links in the 26 new board/mirror files resolve; all new internal dependency edges are acyclic; no TODO/TBD/placeholder markers remain.
- All new cards have one row in PLAN_MAP; every story has one issue-index row and a feature-issue link.
- The running folder watcher added template metadata/sections to new cards; their display metadata was normalized to the declared To Do / High values and the final records were revalidated.
- Scoped whitespace checks pass for the changed indexes and newly created planning files.
- Acceptance-to-test mapping covers AC1–AC12; detailed implementation commands and close conditions are in the feature.

No application build, unit suite, E2E, real-provider execution or visual verification was performed for this documentation-only change. Those are implementation release gates, not evidence already earned.

## Entry point

Start TASK-476, then TASK-477. The remaining tasks form the explicit dependency chain through TASK-487. Read the feature's full data model, persistence, IPC, context, recovery and migration decisions before changing code. Review and preserve the existing uncommitted session-reuse/sidebar changes; this plan replaces their mechanisms only after equivalent tests pass.
