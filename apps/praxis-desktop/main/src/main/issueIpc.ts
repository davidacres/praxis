import { ipcMain } from 'electron';
import type {
  CreateIssueInput,
  IssueFilters,
  ParentItemQueryOptions,
  UpdateIssueInput
} from '@praxis/core';
import { getServiceForConnection } from './serviceRegistry';

export function registerIssueIpc(): void {
  ipcMain.handle(
    'issue:list',
    async (
      _event: Electron.IpcMainInvokeEvent,
      filters: IssueFilters,
      startAt: number,
      pageSize: number,
      connectionId?: string
    ) => {
      return (await getServiceForConnection(connectionId)).getIssues(filters, startAt, pageSize);
    }
  );

  ipcMain.handle(
    'issue:getFilterMetadata',
    async (_event: Electron.IpcMainInvokeEvent, filters: IssueFilters, connectionId?: string) => {
      return (await getServiceForConnection(connectionId)).getFilterMetadata(filters);
    }
  );

  ipcMain.handle(
    'issue:get',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, connectionId?: string) => {
      return (await getServiceForConnection(connectionId)).getIssue(issueKey);
    }
  );

  ipcMain.handle(
    'issue:create',
    async (_event: Electron.IpcMainInvokeEvent, input: CreateIssueInput, connectionId?: string) => {
      return (await getServiceForConnection(connectionId)).createIssue(input);
    }
  );

  ipcMain.handle(
    'issue:update',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      input: UpdateIssueInput,
      connectionId?: string
    ) => {
      return (await getServiceForConnection(connectionId)).updateIssue(issueKey, input);
    }
  );

  ipcMain.handle(
    'issue:delete',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, connectionId?: string) => {
      await (await getServiceForConnection(connectionId)).deleteIssue(issueKey);
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
      await (await getServiceForConnection(connectionId)).transitionIssue(issueKey, transitionId);
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
      await (await getServiceForConnection(connectionId)).addComment(issueKey, body);
    }
  );

  ipcMain.handle(
    'issue:getSelfAssigneeLabel',
    async (_event: Electron.IpcMainInvokeEvent, connectionId?: string) => {
      return (await getServiceForConnection(connectionId)).getSelfAssigneeLabel();
    }
  );

  ipcMain.handle(
    'issue:getProjects',
    async (_event: Electron.IpcMainInvokeEvent, connectionId?: string) => {
      return (await getServiceForConnection(connectionId)).getProjects();
    }
  );

  ipcMain.handle(
    'issue:getParentItems',
    async (
      _event: Electron.IpcMainInvokeEvent,
      filters: IssueFilters,
      searchText?: string,
      options?: ParentItemQueryOptions,
      connectionId?: string
    ) => {
      return (await getServiceForConnection(connectionId)).getParentItems(filters, searchText, options);
    }
  );
}
