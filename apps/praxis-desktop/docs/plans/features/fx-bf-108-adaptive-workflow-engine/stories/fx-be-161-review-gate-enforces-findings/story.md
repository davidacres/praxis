---
**Status:** ✅ Complete
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Story
**Priority:** High
id: FX-BE-161
type: Story
status: Done
created: 2026-10-08
priority: High
featureId: 108
---

# Governed delivery's review gate enforces its findings

## Impact

The default delivery template stops waving changes through. A review that reports a high or critical problem holds the Approve gate, and the approver sees the findings instead of a green tick.

## Scope

`governedDeliveryTemplate()` in `packages/core/src/workflows/workflowTemplates.ts`. Review changes from a `report` output to a required `findings` output (the reviewer brief, `STRUCTURED_CODE_REVIEW_SYSTEM_PROMPT`, already demands that JSON block), adds the plan as an input, and Approve gains `gateThresholds` for `review` (and `security` where the scan produces findings). The Full SDLC templates already do this and are the model. No new engine capability.

## Acceptance criteria

- Review declares a required `findings` output and takes `plan-doc` as an input so it can judge the change against what was asked.
- `stageOutcomeFromSession` therefore parses the reviewer's JSON block into `state.findings`; a reply with prose but no findings block fails the stage with the existing "findings required" message.
- Approve declares `gateThresholds.review` of no finding at `high` or above; a run whose review reports one cannot be approved until it is waived (`waivers`) or re-reviewed.
- The Security scan's `npm audit` output is parsed through a `checkResultAdapters` adapter so the `security` gate also evaluates findings, not only the exit code. If no adapter exists for `npm audit --json`, one is added with a fixture of real output.
- Existing runs of the old template still load; a run started before the change keeps its stored definition.
- A unit test round-trips the changed template through `normalizeWorkflow`; an e2e (or core) test shows a seeded high-severity review finding holding the gate.

## Delivered

Review delivers a required `review-findings` output judged against `plan-doc`, runs `independentOf: implement`, and Approve holds on any `high`+ review or security finding (`gateThresholds`). The security scan runs `npm audit --json` through the `npm-audit` adapter, which now reads the report out of output interleaved with npm warnings and treats npm's own `{ "error": … }` as a parse error; the check runner lets an environment failure win over that parse error, so an audit against a registry with no audit endpoint still pauses rather than fails.

Verified by `workflowTemplates.test.ts` (template shape, thresholds, loops, validation), `checkResultAdapters.test.ts` (mixed output, clean report, npm error JSON), `workflowCheckRunner.test.ts` (a fake `npm` exercising the real classifier: a high advisory fails with findings; a 404 audit endpoint pauses), and `workflowRun.spec.ts` / `workflowLoops.spec.ts` end to end.

## Dependencies

None.

## Description

Close the hole where any non-empty review reply satisfies the review gate.

## Comments
