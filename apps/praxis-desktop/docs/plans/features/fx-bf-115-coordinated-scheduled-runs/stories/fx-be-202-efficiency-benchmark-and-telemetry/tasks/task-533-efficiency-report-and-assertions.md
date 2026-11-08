---
**Status:** To Do
**Created:** 2026-11-08
**Type:** Task
**Priority:** High
id: TASK-533
type: Task
status: To Do
priority: High
created: 2026-11-08
updated: 2026-11-08
feature: FX-BF-115
story: FX-BE-202
---

# TASK-533: Implement schedule efficiency report and verification assertions

Parent: [FX-BE-202](../story.md). Design: [FX-BF-115](../../../feature.md).

## Goal and scope

Implement report generation and automated performance assertions in `packages/core/src/scheduledRuns/scheduledEfficiencyReporter.ts`:
1. `generateEfficiencyComparisonReport(metrics: ScheduleBenchmarkMetrics): string`:
   - Formats a markdown report with executive summary, side-by-side metric table (tokens, time, calls, cost), and percentage efficiency deltas.
   - Highlights redundant exploration reduction and speedup factor.
2. `assertScheduleEfficiencyThresholds(metrics: ScheduleBenchmarkMetrics)`:
   - Asserts exploratory token savings >= 30%.
   - Asserts wall-clock duration speedup >= 20%.
   - Asserts zero failed check stages or test regressions.
3. Wire into CI / scheduled run test suite so any regression in coordination efficiency fails the build.

## Dependencies

- [TASK-532](task-532-comparative-benchmark-harness.md)

## Acceptance criteria

- `generateEfficiencyComparisonReport` outputs valid GitHub Flavored Markdown with clean alignment and metric tables.
- `assertScheduleEfficiencyThresholds` throws descriptive errors with specific measured vs required values when thresholds are not met.
- Running the efficiency suite against the golden fixture confirms:
  - Exploratory calls on shared modules drop by at least 30%.
  - Total elapsed batch duration drops by at least 20%.
  - All test suites in `check` stages pass with identical test coverage.

## Validation

Add unit tests in `packages/core/src/scheduledRuns/scheduledEfficiencyReporter.test.ts` testing report formatting and threshold assertions with passing and failing metric inputs.

## Done when

All acceptance criteria pass and automated efficiency assertions are verified.

## Description


## Comments
