import { reviewedIssueKey, type AiSessionManager, type ProjectRecord } from '@praxis/core';
import { getConnectionStore } from './connectionStoreInstance';
import { getProjectStore } from './projectStoreInstance';

/** Resolve ticket ownership from an explicit connection or a unique saved ticket. */
export function resolveTicketProject(connectionId: string | undefined, issueKey: string): ProjectRecord | undefined {
  const projects = getProjectStore();
  if (connectionId) {
    const configuredId = getConnectionStore().getConnection(connectionId)?.settings.projectId;
    const projectId = typeof configuredId === 'string' ? configuredId
      : connectionId.startsWith('project:') ? connectionId.slice('project:'.length) : undefined;
    if (projectId) return projects.get(projectId);
  }
  const matches = projects.list().filter(project => project.workItems.some(item => item.key === issueKey));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Older reviews saved the connection but omitted the owning project. */
export function recoverTicketReviewProjects(manager: AiSessionManager): void {
  for (const session of manager.getAllAgentSessions().values()) {
    if (session.projectId) continue;
    const issueKey = reviewedIssueKey(session.issueKey);
    if (!issueKey) continue;
    const project = resolveTicketProject(session.connectionId, issueKey);
    if (project) manager.updateAgentRuntime(session.issueKey, { projectId: project.id });
  }
}
