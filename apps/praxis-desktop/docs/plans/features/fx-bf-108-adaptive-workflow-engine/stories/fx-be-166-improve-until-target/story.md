---
**Status:** ✅ Complete
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Story
**Priority:** High
id: FX-BE-166
type: Story
status: Done
created: 2026-10-08
priority: High
featureId: 108
---

# Improve-until-target template, run parameters and keep-best

## Impact

A user picks "Improve until target", states a goal and a number of iterations, and gets the best version the loop found, with the score of every iteration, not simply the last one.

## Scope

Run parameters (`StartRunDialog.tsx`, `WorkflowRun`, IPC), a new built-in template, a scoring contract, and best-so-far tracking in the run record. Uses loop edges (FX-BE-162), loop context (FX-BE-163) and an independent evaluator (FX-BE-164).

## Acceptance criteria

- A workflow may declare run parameters (`goal` text, `maxIterations`, optional `target` metric and value). The start-run dialog renders them, and the values are fixed for the life of the run and recorded on it. `maxIterations` overrides the loop edge's declared budget, never above the documented ceiling.
- The template is: Baseline → Evaluate → (improve while below target and iterations remain) → Improve one focus → Verify (tests/checks as a hard gate) → Evaluate → loop. Each Improve pass is told to address only the top N findings.
- The evaluator returns a score through a defined contract (a `metrics` entry or a rubric score) plus findings. A numeric target, a no-findings-above-threshold condition, or "no improvement over the previous iteration" ends the loop early; the count is a ceiling.
- Each iteration's result is a commit and its score is stored on the run (`iterationScores`). If an iteration scores worse than the best so far it is reverted to the best commit, recorded as reverted, and the next pass is told what failed.
- Test files are protected from the Improve stage: edits to them are flagged in the verify step and fail it unless the stage declares tests as in scope, so a loop cannot reach its target by weakening the tests that guard it.
- The run ends at the best-scoring commit and goes to a final approval whose summary shows the score curve, what each iteration changed, and what was reverted. A subjective goal requires a rubric; the template refuses to start without a target or rubric.
- A run that ends at the iteration ceiling below target is reported as "target not reached" with the best score, not as success.
- Provider and model per stage, tier escalation and provider-limit pauses behave as in any run.

## Delivered

Run parameters on the definition, checked by `resolveRunParameters` and fixed on the run; `bindsLoopEdge` sets a loop's budget and `valueFromParameter` a loop's metric target. The built-in **Improve until target** template (baseline → improve → tests → independent evaluate → keep-best loop with patience 2 → approve) refuses to start without a target or rubric, undoes a worse pass before the next, ends on its best code and says when the target was not reached. `guardTests` (`testGuard.ts`) fails and undoes an attempt that deletes, skips or loosens tests or lowers a coverage threshold.

Verified by `workflowImprove.test.ts` (test guard in each form, template validity, convergence to target, revert-then-stop with the final restore, accepting at the ceiling) and `runWork.test.ts` (restoring the best iteration on a real repository). The template's convergence is proven with scripted stage outcomes through the real orchestrator rather than fixture agents in Electron.

## Dependencies

FX-BE-162
FX-BE-163
FX-BE-164

## Description

Ship an iterate-toward-a-goal template with run parameters and keep-best behaviour.

## Comments
