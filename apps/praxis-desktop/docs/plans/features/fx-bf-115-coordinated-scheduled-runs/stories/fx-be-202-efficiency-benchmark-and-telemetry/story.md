---
**Status:** To Do
**Created:** 2026-11-08
**Type:** Story
**Priority:** High
id: FX-BE-202
type: Story
status: To Do
priority: High
created: 2026-11-08
updated: 2026-11-08
feature: FX-BF-115
---

# FX-BE-202: Efficiency benchmark harness and comparative telemetry

Parent: [FX-BF-115](../../feature.md).

## User or operational impact

Praxis gains an automated, reproducible benchmark harness and comparative telemetry suite that quantitatively proves the efficiency of coordinated scheduled runs and subagents over the legacy isolated-workflow baseline. Every release evaluates token consumption, redundant exploration calls, and wall-clock time, generating an audit artifact that asserts required performance improvements before changes ship.

## Scope

- Build a benchmark runner in `packages/core/src/scheduledRuns/scheduledEfficiencyBenchmark.ts` that executes a standard golden fixture batch (3 related feature/task tickets touching shared interfaces) under both:
  1. **Legacy Baseline:** Uncoordinated sequential workflow runs with cold per-stage sessions.
  2. **Coordinated Subagent Model:** Preflight batch blueprint, shared context cache, and worktree subagent delegation.
- Capture granular comparative telemetry metrics:
  - Total wall-clock duration (seconds).
  - Cumulative input and output tokens, and estimated USD spend.
  - Number of exploratory tool calls (`read_file`, `search_code`, `list_dir`) and redundant read ratio.
  - Total process spawn count and handshake latency.
- Generate a structured benchmark scorecard (`efficiency-benchmark.json` and markdown report).
- Add CI/test assertions verifying the required performance thresholds:
  - >= 30% reduction in exploratory tool calls on shared files.
  - >= 20% reduction in total wall-clock execution duration.
  - Zero test regression or verification degradation in check stages.

## Dependencies

- [FX-BE-200](../fx-be-200-batch-context-and-blueprint/story.md)
- [FX-BE-201](../fx-be-201-subagent-delegation-and-shared-context/story.md)

## Acceptance criteria

- 532: Benchmark harness runs deterministically against a temporary mock repository fixture without mutating working checkouts or real plans.
- 532: Telemetry collector records exact timestamped metrics for both baseline and coordinated modes across all stages.
- 533: Automated tests assert:
  - `(baseline.exploratoryTokens - coordinated.exploratoryTokens) / baseline.exploratoryTokens >= 0.30`
  - `(baseline.wallClockSeconds - coordinated.wallClockSeconds) / baseline.wallClockSeconds >= 0.20`
- 533: Benchmark produces a structured markdown report summarizing token savings, duration differences, and verification outcomes.

## Tasks

- [TASK-532: Build comparative schedule benchmark harness and telemetry collector](tasks/task-532-comparative-benchmark-harness.md)
- [TASK-533: Implement schedule efficiency report and verification assertions](tasks/task-533-efficiency-report-and-assertions.md)

## Validation

Run `npm run test:core` and `node ./packages/core/out/scheduledRuns/scheduledEfficiencyBenchmark.test.js`.

## Close when

Both tasks satisfy all acceptance criteria and the benchmark suite proves >= 30% exploration reduction and >= 20% speedup.

## Description


## Comments
