import type { LogSink } from '@praxis/core';
import { getLogBus } from './logBusInstance';

/**
 * Workflow-tagged tee of the shared log bus, matching the `jira`/`gitlab`/`ai`
 * tees in serviceRegistry.ts and aiInstance.ts. Colocated here (not in either
 * consumer) because two files need it — workflowOrchestratorInstance.ts and
 * workflowAgentStage.ts — and workflowAgentStage.ts is imported BY
 * workflowOrchestratorInstance.ts, so defining it in either would risk a cycle.
 *
 * For failures that have no other visible surface: a run's own stage
 * failures/timeouts already show in the run monitor's timeline and stage
 * detail (they're part of WorkflowRun.events), so logging those here too would
 * just duplicate that UI. This is for the failures that don't reach the run's
 * own event log at all — a write-back comment that couldn't post, a worktree
 * snapshot commit that failed silently behind a stage still reporting
 * `succeeded`.
 */
export const workflowLogSink: LogSink = getLogBus().tee('workflow', { appendLine: line => console.log(line) });
