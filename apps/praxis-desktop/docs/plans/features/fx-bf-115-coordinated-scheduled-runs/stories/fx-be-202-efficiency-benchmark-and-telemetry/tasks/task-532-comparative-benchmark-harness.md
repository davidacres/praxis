---
**Status:** To Do
**Created:** 2026-11-08
**Type:** Task
**Priority:** High
id: TASK-532
type: Task
status: To Do
priority: High
created: 2026-11-08
updated: 2026-11-08
feature: FX-BF-115
story: FX-BE-202
---

# TASK-532: Build comparative schedule benchmark harness and telemetry collector

Parent: [FX-BE-202](../story.md). Design: [FX-BF-115](../../../feature.md).

## Goal and scope

Create `packages/core/src/scheduledRuns/scheduledEfficiencyBenchmark.ts`:
1. Construct a standardized golden fixture test repository with 3 related tickets:
   - Ticket 1: Define shared type and validation utility.
   - Ticket 2: Implement storage consumer using the shared type.
   - Ticket 3: Add UI component rendering the storage items.
2. Provide a runner function `runScheduleEfficiencyBenchmark(options)` that executes the fixture batch twice in isolated temporary directories:
   - Run A: Baseline mode (uncoordinated per-ticket, per-stage workflows).
   - Run B: Coordinated mode (preflight blueprint, batch context cache, and subagents).
3. Instrument a telemetry collector wrapping session events and tool invocations:
   - Categorize tool calls into `exploration` (`read_file`, `search_code`, `list_dir`), `mutation` (`write_file`, `edit_file`), and `verification` (`run_command` check).
   - Count duplicate file reads across tickets.
   - Tally token input/output and elapsed duration per ticket and total.

## Dependencies

None

## Acceptance criteria

- Benchmark runs cleanly inside an isolated temporary directory (`fs.mkdtemp`) and cleans up after completion.
- Telemetry collector tracks exact counts of exploratory vs mutation vs verification tool calls.
- Redundant exploration ratio correctly measures the percentage of duplicate reads targeting identical file paths across subsequent tickets.
- Benchmark produces a complete `ScheduleBenchmarkMetrics` object comparing Run A and Run B.

## Validation

Add unit tests in `packages/core/src/scheduledRuns/scheduledEfficiencyBenchmark.test.ts`.

## Done when

All acceptance criteria pass and benchmark runs reliably in `packages/core`.

## Description


## Comments
