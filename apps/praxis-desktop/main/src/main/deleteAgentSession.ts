import { BrowserWindow } from 'electron';
import { abortActiveTask, getAiSessionManager } from './aiInstance';
import { disposeBrowserMcpForSession } from './browserMcp';

/**
 * Stops a session's active task and removes it. Shared by `ai:deleteSession`
 * and workflow-run deletion, so a run's stage sessions go the same way a user
 * deleting them from the tree would.
 */
export async function deleteAgentSession(issueKey: string): Promise<void> {
  const sessionManager = getAiSessionManager();
  await abortActiveTask(issueKey);
  disposeBrowserMcpForSession(issueKey);
  sessionManager.removeAgentSession(issueKey);
  sessionManager.removeSession(issueKey);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('ai:sessionDeleted', issueKey);
    }
  }
}
