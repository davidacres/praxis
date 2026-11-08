---
**Status:** To Do
**Created:** 2026-11-08
**Type:** Feature
**Priority:** High
id: FX-BF-115
type: Feature
status: To Do
priority: High
created: 2026-11-08
updated: 2026-11-08
---

# FX-BF-115: Coordinated Scheduled Runs with Batch Context Sharing and Subagent Acceleration

## Outcome

Scheduled runs process queued and related tickets with significantly higher throughput, lower wall-clock latency, and reduced token expenditure by executing a preflight batch coordination analysis, sharing warm codebase context across ticket stages, and delegating sub-tasks to bounded subagents — while strictly preserving Praxis's core reliability guarantees (deterministic test/build checks, independent reviewer stages, per-ticket failure boundaries, and provider budget controls). Concrete automated comparative benchmarks prove measurable efficiency gains (at least 30% reduction in redundant exploration tokens and at least 20% faster wall-clock execution) over the legacy isolated-workflow baseline.

## Scope and boundaries

- **In scope:**
  - Introduce `ScheduledBatchBlueprint` and `ScheduledBatchContext` contracts in `@praxis/core` for whole-schedule dependency analysis, shared module discovery, and cached codebase context.
  - Add a preflight Batch Architect stage in `packages/core/src/scheduledRuns/` that evaluates the entire scheduled queue of tickets before individual ticket dispatch, identifying common touched files, shared type contracts, and optimal execution ordering.
  - Implement a `BatchContextCache` that forwards exploratory discoveries, symbol maps, and upstream ticket deliverables into subsequent ticket stages, eliminating cold-start exploration churn.
  - Allow implementation stages (`workflowAgentStage.ts`) running in autonomous mode to spawn concurrent, worktree-bounded subagents for sub-tasks (e.g. creating helper modules, parallel tests, or updating secondary consumers) while keeping the root stage responsible for compilation, git commits, and stage exit.
  - Retain **deterministic verification gates**: `check` stages (linters, typecheckers, test suites) and git merge operations remain strict, out-of-process deterministic commands outside the LLM hallucination boundary.
  - Retain **reviewer independence**: review stages remain strictly independent (`node.independentOf`) with read-only toolsets.
  - Build a reproducible comparative benchmark suite (`scheduledEfficiencyBenchmark.test.ts`) that executes a standardized golden fixture batch under both the legacy isolated model and the coordinated subagent model, capturing token usage, redundant tool calls, and wall-clock time, and asserting required efficiency deltas.

- **Out of scope:**
  - Replacing the core workflow engine DAG with an unrestricted, freeform autonomous agent.
  - Allowing subagents to commit directly to git or bypass branch isolation.
  - Overriding provider budget policies or handover thresholds established in FX-BF-047 / FX-BE-148.

## Current implementation baseline vs coordinated model

| Dimension | Current Baseline (FX-BF-047 / FX-BE-148) | Coordinated Subagent Model (FX-BF-115) |
| --- | --- | --- |
| **Session Lifecycle** | 1 new ACP agent session per stage per ticket (e.g. 5 tickets × 3 stages = 15 cold sessions). | 1 preflight batch architect session + warm context caching across ticket stages + bounded subagents. |
| **Codebase Exploration** | Every stage redundantly runs `read_file`, `search_code`, `list_dir` on shared repo files. | Common architecture, symbols, and touched files are indexed once in the preflight blueprint and injected as warm context. |
| **Cross-Ticket Awareness** | Ticket B is completely unaware of Ticket A's designs or changes until git merge. | Batch blueprint maps cross-ticket interfaces; Ticket B receives Ticket A's delivery summary and modified symbols directly. |
| **Sub-task Execution** | Single agent thread executes all edits sequentially within the stage. | Implementation stage can delegate discrete sub-tasks to parallel child subagents within the isolated worktree. |
| **Quality & Check Gates** | Air-gapped `check` stages (`npm test`, typecheck) execute deterministically. | **Unchanged:** air-gapped `check` stages execute deterministically outside the LLM. |
| **Reviewer Independence** | Independent reviewer session with read-only tools (`node.independentOf`). | **Unchanged:** review stage remains isolated with read-only tool mode. |
| **Failure Containment** | Per-ticket pause and retry boundary on worktree branch. | **Unchanged:** failures isolate to the active ticket; earlier tickets remain committed. |

## Architectural trade-offs and gap analysis

### 1. The "Monolithic Session" Pitfall vs Coordinated Architecture
- *Gap identified:* Merging an entire scheduled run into a single persistent conversation session causes severe **context rot** (token accumulation leading to prompt dilution, lost-in-the-middle hallucinations, high latency per turn, and catastrophic blast radius if the agent crashes on ticket 4 of 5).
- *Resolution:* Do not use one monolithic session. Instead, use a **Preflight Batch Architect Session** to generate a compact, immutable `ScheduledBatchBlueprint`, paired with a **Scoped Batch Context Cache** that injects targeted warm context into isolated ticket stages.

### 2. Deterministic Quality Verification vs Agent Self-Rationalization
- *Gap identified:* Autonomous subagents frequently convince themselves tests pass or skip test execution when under token or time pressure.
- *Resolution:* Workflow `check` stages remain 100% deterministic shell executions executed by the workflow runner. The schedule runner advances only when external exit codes are zero.

### 3. Reviewer Independence
- *Gap identified:* A subagent reviewing code written by a sibling subagent inside the same conversation inherits the author's prompt biases.
- *Resolution:* Review stages run in a distinct agent session with read-only tool capabilities, enforcing `node.independentOf`.

### 4. Measurable Efficiency Proof
- *Gap identified:* Claims of "faster" and "more efficient" must be mathematically verified against actual token usage and runtime.
- *Resolution:* Build an automated telemetry comparison harness that benchmarks a standardized 3-ticket batch, asserting >= 30% reduction in redundant discovery tool calls and >= 20% reduction in elapsed execution time.

## Feature acceptance criteria

- AC1: When a scheduled run with two or more related tickets starts, the runner executes a preflight batch analysis pass that produces a valid `ScheduledBatchBlueprint` identifying shared files, symbol references, and ticket dependencies.
- AC2: Individual ticket stages receive the preflight blueprint and previous tickets' handover summaries via `taskDefinition.scope`, eliminating cold-start exploration for previously examined files.
- AC3: Implementation stages can delegate discrete, non-conflicting tasks to worktree-bounded subagents using standard `task`/`subagent` invocations, aggregating child task events under the parent stage.
- AC4: If any subagent or ticket stage fails or throws an unhandled error, the failure is contained to that specific ticket; prior completed tickets remain intact and committed on the delivery branch, and the schedule pauses with a actionable recovery state.
- AC5: Running the comparative efficiency benchmark suite (`scheduledEfficiencyBenchmark.test.ts`) against the standard fixture demonstrates at least a 30% decrease in exploratory token usage and at least a 20% improvement in total wall-clock completion time compared to isolated baseline execution.

## Stories

- [FX-BE-200: Batch context analysis and preflight blueprint engine](stories/fx-be-200-batch-context-and-blueprint/story.md)
- [FX-BE-201: Subagent stage delegation and shared execution context](stories/fx-be-201-subagent-delegation-and-shared-context/story.md)
- [FX-BE-202: Efficiency benchmark harness and comparative telemetry](stories/fx-be-202-efficiency-benchmark-and-telemetry/story.md)

## Description


## Comments

## Dependencies


