/**
 * Which other AI to use when one runs out of credits or hits its usage limit —
 * for a workflow stage (the run's `switch` policy, or the user's pick) and for
 * a session the user moves to another AI.
 */
import {
  listProviderIds,
  exhaustedProviders,
  stageProvider,
  type AiProvider,
  type WorkflowRun
} from '@praxis/core';
import { listAiProviderStatuses } from './aiInstance';
import { getSettingsBackend } from './settingsBackendInstance';

/** AIs that are set up (key or CLI present) and not turned off, in the order they are preferred. */
export async function usableProviders(preferred: readonly string[] = []): Promise<AiProvider[]> {
  const usable = new Set(
    (await listAiProviderStatuses()).filter(status => status.configured && status.enabled).map(status => status.provider)
  );
  const order = [...preferred, getSettingsBackend().read().ai.activeProvider, ...listProviderIds()];
  return [...new Set(order)].filter((id): id is AiProvider => usable.has(id as AiProvider));
}

/** The first usable AI that is not one of `exclude`. */
export async function nextUsableProvider(exclude: readonly string[], preferred: readonly string[] = []): Promise<AiProvider | undefined> {
  return (await usableProviders(preferred)).find(id => !exclude.includes(id));
}

/** For the `switch` policy: the next AI for a stage, skipping every AI that ran out in this run. */
export function fallbackProviderForStage(run: WorkflowRun, nodeId: string): Promise<AiProvider | undefined> {
  const active = getSettingsBackend().read().ai.activeProvider;
  const current = stageProvider(run, nodeId, run.aiProvider || active);
  return nextUsableProvider([current, ...exhaustedProviders(run), ...authorProviders(run, nodeId)], run.aiProvider ? [run.aiProvider] : []);
}

/**
 * For an independent reviewer (`independentOf`), the AI the stage it judges ran on: an
 * automatic switch never lands it there, or it would be marking its own work.
 */
function authorProviders(run: WorkflowRun, nodeId: string): string[] {
  const node = run.definition.nodes.find(candidate => candidate.id === nodeId);
  if (!node || node.type !== 'agent-task' || !node.independentOf) return [];
  const attempts = run.nodes[node.independentOf]?.attempts ?? [];
  const latest = [...attempts].reverse().find(attempt => attempt.provider && !attempt.pause);
  return latest?.provider ? [latest.provider] : [];
}
