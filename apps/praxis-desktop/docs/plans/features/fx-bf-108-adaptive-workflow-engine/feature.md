---
**Status:** ✅ Complete
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Feature
**Priority:** High
id: FX-BF-108
type: Feature
status: Done
created: 2026-10-08
priority: High
---

# Adaptive workflow engine: routed results, bounded loops and iterative improvement

## Outcome

A workflow built in the designer can complete work to a high standard on its own: stages hand results to the right next agent, a failed review/security/QA result loops back to a fixing stage and is re-verified, independent verifiers keep the author honest, work can fan out in parallel, and an "improve until target" template can iterate a solution a chosen number of times toward a goal. Every loop is bounded, every iteration is auditable, and a run that does not converge ends in front of a person with the evidence, never silently.

## Why now

An analysis of the shipped `governed-delivery` template (2026-10-08) found:

- The Review gate cannot fail on what the review finds: Review emits a `report`, the template has no `gateThresholds`, and `stageOutcomeFromSession` only parses findings when a `findings` output is declared. Any non-empty reply passes the gate.
- A review or security finding never reaches the code. The only fix loop is QA failure → `qa-repair-agent` (`failureRecovery`); anything else ends at a human rejection that fails the branch.
- The static validator (`workflowValidation.findCycle`) rejects every cycle, so loops can only be `maxAttempts` retries of one stage.
- A retry changes the model tier but is not told why the previous attempt failed.
- Nothing makes a verifier independent of the author, and the graph is static so it cannot fan out over "these N findings" or "these N modules".
- The recommended design is also informed by Anthropic's "ultracode" / dynamic workflows (fresh context per agent, separate verifier, skeptic agents, isolated worktrees for parallel writers, resume by completed stage), reported in third-party write-ups only; Anthropic's own workflow documentation has not been reviewed.

## Scope

Extend the existing engine; do not replace it. The designer stays the authoring surface and a workflow stays data (`WorkflowDefinition`). New capability is added as edge/node kinds the validator, scheduler, run record, designer and run view all understand. Rework reuses `reworkWorkflowRun`; gates reuse `evaluateGates` severity/metric conditions; model choice reuses `chooseStageModel`.

Out of scope: a generated-at-runtime workflow script, remote execution, cross-run learning, and any change to approval semantics (a delivery sign-off still needs a person and cannot be skipped).

## Constraints that apply to every story

- **Backwards compatibility is the gate.** A workflow with no new fields behaves byte-identically. `folder.spec.ts`, `folderMulti.spec.ts`, `editIssue.spec.ts`, `newIssue.spec.ts` hold at 13 passed and the existing workflow specs keep their counts.
- **`normalizeWorkflow` copies fields one by one** (`workflowValidation.ts`). Every new node/edge field must be added there and to its round-trip test, or it is silently dropped on first save. `normalizeWorkflowRun` has the same property for run fields.
- **Every loop is finite.** No cycle is valid unless every back-edge carries a budget.
- **Never fail silently.** Budget exhaustion, non-convergence and a failed verifier end at a person with the open findings listed.
- The renderer imports types only from `@praxis/core`.

## Story map

- [FX-BE-161: Governed delivery's review gate enforces its findings](stories/fx-be-161-review-gate-enforces-findings/story.md)
- [FX-BE-162: Findings-routed edges and bounded loop edges](stories/fx-be-162-routed-edges-and-bounded-loops/story.md)
- [FX-BE-163: Loop context and retry memory](stories/fx-be-163-loop-context-and-retry-memory/story.md)
- [FX-BE-164: Independent verification and skeptic stages](stories/fx-be-164-independent-verification/story.md)
- [FX-BE-165: Map node: parallel fan-out with isolated worktrees](stories/fx-be-165-map-fan-out/story.md)
- [FX-BE-166: Improve-until-target template, run parameters and keep-best](stories/fx-be-166-improve-until-target/story.md)
- [FX-BE-167: Designer, run view and cost visibility for loops](stories/fx-be-167-designer-run-view-and-cost/story.md)

## Delivery order

FX-BE-161 is independent and ships first (small, closes the largest hole). FX-BE-162 is the engine change everything else builds on. FX-BE-163 and FX-BE-164 follow it. FX-BE-166 needs 162, 163 and 164. FX-BE-165 needs 162 and can proceed in parallel with 166. FX-BE-167 lands with 162 for the designer part and completes after 165/166.

## Dependencies

Related: FX-BF-035 (multi-AI session orchestration), FX-BF-034 (SDLC quality and security gates), FX-BF-019 (workflow as data), FX-BF-048 (agent session coordination, for shared-resource contention between parallel writers). None is a blocking prerequisite.

## Close conditions

- The shipped Governed delivery template, run against a ticket with a deliberately planted bug, reports it, loops to a fix, re-verifies and converges, or escalates with the findings listed when the budget is spent.
- An "Improve until target" run with a numeric goal and N iterations ends at the best-scoring commit and records the score of every iteration.
- A map stage fans a findings list out to parallel isolated worktrees and merges the results.
- Existing workflows and the e2e gate counts are unchanged.
- Planning complete does not mean implementation complete.

## Delivered (2026-10-08)

All seven stories and seventeen tasks are implemented. Each story's own "Delivered" section names the code and the tests behind it.

Verification at completion:

- `npm run test:core`: 1,456 passed, 0 failed (1,393 before this feature).
- `npm run check-types`: clean across every workspace.
- Desktop unit tests: `test:workflows` 38 passed, `test:git` 50 passed, including real-repository tests for keep-best restore and map-item merges.
- `npm run test:desktop` (functional project): 503 passed, 2 failed, 3 skipped. `aiCliAgentHost` "ACP resume replay" is the documented flake and passed alone. The `marketplace` Agent Runtime snapshot was 10px narrower because the new bundled skeptic agent makes the panel scroll; its content was identical, and it was re-baselined after inspection.
- The workflow specs and the folder/edit/new-issue gate specs all pass after the final changes.
- The designer, connection inspector, loop history, needs-decision notice and start dialog were inspected in light and dark.

Not verified: the first close condition was proven with scripted stage outcomes through the real orchestrator and the manual run seam, not with a live AI. A real run of Governed delivery against a deliberately buggy ticket is still the honest end-to-end test of whether real reviewers and implementers converge.

## Description

Make the workflow designer powerful enough to describe workflows that route results, loop back to re-code or re-test, and iterate toward a goal, with bounded and auditable behaviour.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-161 | Story | Governed delivery's review gate enforces its findings | Done |
| FX-BE-162 | Story | Findings-routed edges and bounded loop edges | Done |
| FX-BE-163 | Story | Loop context and retry memory | Done |
| FX-BE-164 | Story | Independent verification and skeptic stages | Done |
| FX-BE-165 | Story | Map node: parallel fan-out with isolated worktrees | Done |
| FX-BE-166 | Story | Improve-until-target template, run parameters and keep-best | Done |
| FX-BE-167 | Story | Designer, run view and cost visibility for loops | Done |

## Comments
