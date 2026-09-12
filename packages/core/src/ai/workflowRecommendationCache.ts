/**
 * Persists one AI agent recommendation per workflow stage — the answer to
 * "which agent fits this stage" doesn't change unless the stage itself does,
 * so computing it is a paid AI call the designer should make **once**, not
 * every time the stage inspector is opened. This cache is what makes that
 * true: `workflows:recommendAgent` writes into it after a real call,
 * `workflows:getRecommendation` reads it back for free, and the renderer
 * only ever triggers a real call from an explicit user action — the first
 * "Recommend" click, or an explicit refresh afterwards. Nothing here polls
 * or recomputes on its own.
 */

import type { KeyValueStore } from '../host/stateStore';
import type { AiProvider } from '../types';
import { computeRecommendationFingerprint, type AgentRecommendationInput } from './workflowAgentRecommendation';

export interface StoredAgentRecommendation {
  agentId: string;
  rationale: string;
  model: string;
  provider: AiProvider;
  /** ISO 8601 — when this recommendation was computed. */
  computedAt: string;
  /** `computeRecommendationFingerprint` at compute time — compared on read to flag staleness. */
  inputFingerprint: string;
}

const CACHE_KEY = 'praxis.workflowAgentRecommendations.v1';

function cacheKey(workflowId: string, nodeId: string): string {
  return `${workflowId}:${nodeId}`;
}

export class WorkflowRecommendationCache {
  constructor(private readonly store: KeyValueStore) {}

  private readAll(): Record<string, StoredAgentRecommendation> {
    return this.store.get<Record<string, StoredAgentRecommendation>>(CACHE_KEY) ?? {};
  }

  /**
   * The stored recommendation for this stage, if any, plus whether the
   * stage's current name/instructions/candidates still match what it was
   * computed against. `stale: true` is a hint for the UI to suggest a
   * refresh — it never triggers one.
   */
  public get(
    workflowId: string,
    nodeId: string,
    currentInput: AgentRecommendationInput
  ): { recommendation: StoredAgentRecommendation | undefined; stale: boolean } {
    const recommendation = this.readAll()[cacheKey(workflowId, nodeId)];
    if (!recommendation) {
      return { recommendation: undefined, stale: false };
    }
    const stale = recommendation.inputFingerprint !== computeRecommendationFingerprint(currentInput);
    return { recommendation, stale };
  }

  public async set(workflowId: string, nodeId: string, value: StoredAgentRecommendation): Promise<void> {
    const all = this.readAll();
    all[cacheKey(workflowId, nodeId)] = value;
    await this.store.update(CACHE_KEY, all);
  }

  /** Drops a stage's cached recommendation — e.g. when the stage itself is removed. */
  public async clear(workflowId: string, nodeId: string): Promise<void> {
    const all = this.readAll();
    if (!(cacheKey(workflowId, nodeId) in all)) {
      return;
    }
    delete all[cacheKey(workflowId, nodeId)];
    await this.store.update(CACHE_KEY, all);
  }
}
