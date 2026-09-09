---
type: Story
id: FX-BE-089
title: "Structured code review and inline delivery"
status: planned
feature: FX-BF-034
updated: 2026-09-09
dependencies: [FX-BE-087, FX-BE-033]
---

# FX-BE-089: Structured code review and inline delivery

**Priority:** High
**Created:** 2026-09-09

## Outcome

Make the `review` gate behave like a reviewer. The reviewer stage must return a `findings` artifact (file, line, severity, category, optional suggested patch), validated like any artifact; summary prose is allowed alongside but is not the gate evidence. Findings are posted as inline review comments on the project's GitHub/GitLab PR when there is one, else as a structured ticket comment, deduped against the previous run's fingerprints. Findings at or above a configured blocking severity route back to a bounded re-implement stage, then re-review, before the gate can pass.

## Scope and implementation entry points

packages/core/src/ai (`aiReviewService.ts` prompts as the reviewer brief; review-result parsing); packages/core/src/workflows (`workflowStageSession.ts`, gate evaluation, the review→implement edge and attempt budget); apps/praxis-desktop/main/src/main (PR/MR comment IPC, reusing the GitHub/GitLab REST clients); apps/praxis-desktop/renderer/src/ai and workflows (review findings surface, Local Peer Review reuse).

## Dependencies

- FX-BE-087
- FX-BE-033
## Ordered tasks

| Order | Ref | Work |
| --- | --- | --- |
| 1 | [TASK-244](tasks/task-244-define-the-structured-reviewer-artifact-contract.md) | Define the structured reviewer artifact contract |
| 2 | [TASK-245](tasks/task-245-deliver-review-findings-as-inline-comments.md) | Deliver review findings as inline PR / ticket comments with dedupe |
| 3 | [TASK-246](tasks/task-246-add-a-bounded-review-fix-loop.md) | Add a bounded review to implement fix loop |

## Acceptance criteria

- A reviewer stage that returns only prose fails its artifact contract with a stated reason; one that returns valid `findings` satisfies it, and the `review` gate rests on the finding severities, not on the agent reporting success.
- Inline delivery posts one comment per finding at the right file/line on a fixture PR, and a re-review of an unchanged snapshot adds nothing (fingerprint dedupe); with no PR, a single structured ticket comment is posted instead.
- A seeded blocking-severity finding routes back to a re-implement stage within the attempt budget; a clean re-review then passes the gate; exhausting the budget fails the run with the blocking findings listed.
- The engine still decides the gate: no path lets an agent mark `review` passed while a blocking un-waived finding stands.
- All child tasks have implementation and verification evidence.

## Verification

Scripted-ACP reviewer fixture returning canned structured findings; fixture GitHub/GitLab servers for the comment path; core tests for contract validation, dedupe and the fix-loop budget. Electron specs for the review findings surface with inspected captures across theme axes and keyboard focus. Prove the "prose-only fails" and "no gate pass with blocking finding" guards fail against pre-change behaviour. Update user-guide review section and feature-parity.

## Exclusions

No conversational back-and-forth on individual comments, no learning/feedback model, and no auto-apply of suggested patches without going through the fix loop. Waivers from FX-BE-088 apply to scanner findings; review findings use the blocking-severity threshold and the fix loop, not the waiver register.
