import { ipcMain } from 'electron';
import type { AttachProjectFolderInput, CreateProjectInput, ProjectBoardReference, UpdateProjectInput } from '@ticket-manager/core';
import { getProjectManager, getProjectStore } from './projectStoreInstance';

export function registerProjectIpc(): void {
  ipcMain.handle('projects:list', () => getProjectManager().list());
  ipcMain.handle('projects:get', (_event, projectId: string) => getProjectManager().get(projectId));
  ipcMain.handle('projects:create', (_event, input: CreateProjectInput) => getProjectManager().create(input));
  ipcMain.handle('projects:update', (_event, projectId: string, patch: UpdateProjectInput) => getProjectStore().update(projectId, patch));
  ipcMain.handle('projects:inspectFolder', (_event, folderPath: string) => getProjectManager().inspectFolder(folderPath));
  ipcMain.handle('projects:attachFolder', (_event, projectId: string, input: AttachProjectFolderInput) => getProjectManager().attachFolder(projectId, input));
  ipcMain.handle('projects:linkBoard', (_event, projectId: string, board: ProjectBoardReference) => getProjectStore().linkBoard(projectId, board));
  ipcMain.handle('projects:unlinkBoard', (_event, projectId: string, connectionId: string, boardId: string) => getProjectStore().unlinkBoard(projectId, connectionId, boardId));
}
