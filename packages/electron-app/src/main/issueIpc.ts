import { ipcMain } from 'electron';
import { getServiceForConnection } from './serviceRegistry';

export function registerIssueIpc(): void {
  ipcMain.handle(
    'issue:get',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, connectionId?: string) => {
      return getServiceForConnection(connectionId).getIssue(issueKey);
    }
  );

  ipcMain.handle(
    'issue:transition',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      transitionId: string,
      connectionId?: string
    ) => {
      await getServiceForConnection(connectionId).transitionIssue(issueKey, transitionId);
    }
  );

  ipcMain.handle(
    'issue:addComment',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      body: string,
      connectionId?: string
    ) => {
      await getServiceForConnection(connectionId).addComment(issueKey, body);
    }
  );
}
