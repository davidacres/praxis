import { abortActiveTask, getAiSessionManager } from './aiInstance';
import { disposeBrowserMcpForSession } from './browserMcp';
import { disposeTrackerMcpForSession } from './trackerMcp';
import { broadcastToAllWindows } from './windowBroadcast';

/**
 * Stops a session's active task and removes it. Shared by `ai:deleteSession`
 * and workflow-run deletion, so a run's stage sessions go the same way a user
 * deleting them from the tree would.
 */
export async function deleteAgentSession(issueKey: string): Promise<void> {
  const sessionManager = getAiSessionManager();
  await abortActiveTask(issueKey);
  disposeBrowserMcpForSession(issueKey);
  disposeTrackerMcpForSession(issueKey);
  sessionManager.removeAgentSession(issueKey);
  sessionManager.removeSession(issueKey);
  broadcastToAllWindows('ai:sessionDeleted', issueKey);
}
