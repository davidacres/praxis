import type { WorkflowDefinition } from '../workflows/workflowTypes';

/** Intermediate tickets must leave the shared delivery branch intact for the next ticket. */
export function workflowForScheduledEntry(definition: WorkflowDefinition, finalEntry: boolean): WorkflowDefinition {
  if (finalEntry) return definition;
  const mergeIds = new Set(definition.nodes.filter(node => node.type === 'merge').map(node => node.id));
  if (mergeIds.size === 0) return definition;
  return {
    ...definition,
    nodes: definition.nodes.filter(node => !mergeIds.has(node.id)),
    edges: definition.edges.filter(edge => !mergeIds.has(edge.from) && !mergeIds.has(edge.to))
  };
}
