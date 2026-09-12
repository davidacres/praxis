import * as path from 'node:path';
import { app } from 'electron';
import { WorkflowRecommendationCache } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';

let cache: WorkflowRecommendationCache | undefined;

/**
 * Shared `WorkflowRecommendationCache` singleton — `userData/workflow-agent-
 * recommendations.json`, same per-profile isolation as the other AI stores.
 * This is what lets `workflows:getRecommendation` answer for free: the
 * designer reopening a stage reads this file, it never re-asks the AI.
 */
export function getWorkflowRecommendationCache(): WorkflowRecommendationCache {
  if (!cache) {
    cache = new WorkflowRecommendationCache(
      new JsonKeyValueStore(path.join(app.getPath('userData'), 'workflow-agent-recommendations.json'))
    );
  }
  return cache;
}

/** Drops the file-backed singleton after its file is cleared by a reset. */
export function resetWorkflowRecommendationCache(): void {
  cache = undefined;
}
