import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { loadProjectWorkflows, normalizeWorkflow, type WorkflowDefinition, type KeyValueStore } from '@praxis/core';

export async function projectWorkflowTrust(store: KeyValueStore, folder: string | undefined, workflowId: string, definition?: WorkflowDefinition, requireSnapshotTrust = false) {
  if (!folder) return { trusted: true, fingerprint: '', commands: [] as string[], key: '' };
  const root = await realpath(folder);
  const entry = (await loadProjectWorkflows(root)).workflows.find(item => item.definition.id === workflowId);
  if (!entry && (!requireSnapshotTrust || !definition)) return { trusted: true, fingerprint: '', commands: [] as string[], key: '' };
  const reviewed = normalizeWorkflow(definition ?? entry!.definition);
  // Run titles are display metadata; all executable nodes/edges remain fingerprinted.
  const { name: _name, ...execution } = reviewed;
  const fingerprint = createHash('sha256').update(JSON.stringify(execution)).digest('hex');
  const key = 'praxis.workflowTrust.v1:' + createHash('sha256').update(root + '\0' + workflowId).digest('hex');
  const commands = reviewed.nodes.flatMap(node => node.type === 'check' ? [`${node.name}: ${node.command} ${(node.args ?? []).map(arg => JSON.stringify(arg)).join(' ')}`] : node.type === 'agent-task' ? [`${node.name}: AI agent (${node.agent.toolMode ?? 'full'} tools)`] : node.type === 'deployment' ? [`${node.name}: deployment profile ${node.deploymentProfileId}`] : []);
  return { trusted: store.get<string>(key) === fingerprint, fingerprint, commands, key };
}
