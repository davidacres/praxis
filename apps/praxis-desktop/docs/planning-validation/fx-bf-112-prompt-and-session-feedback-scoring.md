# FX-BF-112 plan readiness and parser evidence

Plan authored and validated on 2026-10-28. Status: ready to start TASK-488; dependent tasks wait for their named predecessors.

## Parser evidence

Verified with `packages/core/out/folder/markdownPlanParser.js` (`parsePlanFolder(path.resolve('docs/plans'))` from `apps/praxis-desktop`).

| Record type | Before | After | Added |
| --- | --- | --- | --- |
| features | 56 | 57 | 1 |
| stories | 176 | 180 | 4 |
| tasks | 392 | 400 | 8 |
| children | 586 | 598 | 12 |

All 13 added IDs (`FX-BF-112`, `FX-BE-185`..`FX-BE-188`, `TASK-488`..`TASK-495`) occur once, resolve to feature 112, and carry the expected `Feature` / `Story` / `Task` type, `To Do` status, and H1 heading.

## Board-file inventory and rule compliance

Every row below satisfies rule 1 (H1 card title), rule 2 (explicit type + canonical filename), rule 3 (unique planning ID across the plans tree), rule 4 (declared board workflow status `To Do`), rule 5 (`## Dependencies` section), and rule 6 (canonical `feature.md`, `stories/<id>/story.md`, `tasks/<id>.md` layout).

| ID | Type | Status | H1 | File |
| --- | --- | --- | --- | --- |
| FX-BF-112 | Feature | To Do | FX-BF-112: Prompt and session feedback, telemetry analysis, and deterministic scoring | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/feature.md) |
| FX-BE-185 | Story | To Do | FX-BE-185: Deterministic prompt, tool, skill, agent, and MCP evaluation engine | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-185-deterministic-scoring-engine/story.md) |
| TASK-488 | Task | To Do | TASK-488: Define feedback, signal extraction, and deterministic rubric contracts | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-185-deterministic-scoring-engine/tasks/task-488-feedback-and-rubric-contracts.md) |
| TASK-489 | Task | To Do | TASK-489: Implement deterministic prompt, tool, skill, agent, and MCP analyzers | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-185-deterministic-scoring-engine/tasks/task-489-deterministic-signal-analyzers.md) |
| FX-BE-186 | Story | To Do | FX-BE-186: Feedback persistence, IPC commands, and optional AI prompt rewrite | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-186-feedback-persistence-and-ipc/story.md) |
| TASK-490 | Task | To Do | TASK-490: Persist session and prompt feedback evaluations and expose typed IPC | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-186-feedback-persistence-and-ipc/tasks/task-490-feedback-store-and-ipc.md) |
| TASK-491 | Task | To Do | TASK-491: Add optional remediation prompt rewriter grounded in deterministic findings | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-186-feedback-persistence-and-ipc/tasks/task-491-remediation-prompt-rewriter.md) |
| FX-BE-187 | Story | To Do | FX-BE-187: Composer prompt check and session feedback scorecard UI | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-187-composer-and-session-feedback-ui/story.md) |
| TASK-492 | Task | To Do | TASK-492: Add pre-send prompt analyzer and score preview to the session composer | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-187-composer-and-session-feedback-ui/tasks/task-492-composer-prompt-feedback-ui.md) |
| TASK-493 | Task | To Do | TASK-493: Add post-session feedback form, deterministic scorecard, and one-click remediations | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-187-composer-and-session-feedback-ui/tasks/task-493-session-inspector-scorecard-ui.md) |
| FX-BE-188 | Story | To Do | FX-BE-188: End-to-end verification and deterministic scoring corpus proof | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-188-feedback-scoring-verification/story.md) |
| TASK-494 | Task | To Do | TASK-494: Add golden deterministic scoring corpus and IPC unit suites | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-188-feedback-scoring-verification/tasks/task-494-golden-scoring-corpus-tests.md) |
| TASK-495 | Task | To Do | TASK-495: Verify composer and session feedback journeys in Playwright E2E | [plan](../plans/features/fx-bf-112-prompt-and-session-feedback-scoring/stories/fx-be-188-feedback-scoring-verification/tasks/task-495-feedback-ui-e2e-verification.md) |
