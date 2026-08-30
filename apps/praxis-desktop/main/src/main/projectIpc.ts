import { app, ipcMain } from 'electron';
import type { AttachProjectFolderInput, Connection, CreateProjectInput, ProjectBoardReference, ProjectRecord, UpdateProjectInput } from '@praxis/core';
import { getProjectManager, getProjectStore } from './projectStoreInstance';
import { getWorkspaceStore } from './workspaceStoreInstance';
import { getConnectionStore } from './connectionStoreInstance';

/**
 * Existing folders are already the source of truth for their planning files.
 * Register that source as a read-only Live Folder connection so the imported
 * project immediately has a board backed by the files on disk (rather than an
 * empty Praxis-owned board beside them).
 */
async function connectDetectedPlans(project: ProjectRecord): Promise<ProjectRecord> {
  const folder = project.workspaceFolder;
  if (!folder || !(project.folderInspection?.planFiles?.length)) {
    return project;
  }

  const connections = getConnectionStore();
  const connection: Connection = {
    id: `project-plans-${project.id}`,
    name: `${project.name} plans`,
    mode: 'livefolder',
    settings: {
      path: folder,
      projectKey: project.key,
      projectName: project.name,
      // Imported plans stay safe/read-only until the user explicitly enables
      // writing in the Connections screen.
      allowIssueCreation: false
    }
  };
  await connections.addConnection(connection);
  try {
    const board = { connectionId: connection.id, boardId: `livefolder-${project.key.toLowerCase()}`, displayName: `${project.name} (Live)` };
    await connections.addTrackedBoard(board);
    return await getProjectStore().linkBoard(project.id, {
      connectionId: board.connectionId,
      boardId: board.boardId,
      displayName: board.displayName ?? `${project.name} plans (Live)`
    });
  } catch (error) {
    await connections.removeConnection(connection.id).catch(() => undefined);
    throw error;
  }
}

export function registerProjectIpc(): void {
  ipcMain.handle('projects:list', () => getProjectManager().list());
  ipcMain.handle('projects:get', (_event, projectId: string) => getProjectManager().get(projectId));
  ipcMain.handle('projects:create', async (_event, input: CreateProjectInput, workspaceId: string) => {
    const project = await getProjectManager().createInWorkspace(input, workspaceId, getWorkspaceStore(), app.getVersion());
    return connectDetectedPlans(project);
  });
  ipcMain.handle('projects:useExisting', (_event, projectId: string, workspaceId: string) =>
    getProjectManager().useInWorkspace(projectId, workspaceId, getWorkspaceStore(), app.getVersion()));
  ipcMain.handle('projects:update', (_event, projectId: string, patch: UpdateProjectInput) => getProjectStore().update(projectId, patch));
  ipcMain.handle('projects:inspectFolder', (_event, folderPath: string) => getProjectManager().inspectFolder(folderPath));
  ipcMain.handle('projects:attachFolder', (_event, projectId: string, input: AttachProjectFolderInput) => getProjectManager().attachFolder(projectId, input));
  ipcMain.handle('projects:linkBoard', (_event, projectId: string, board: ProjectBoardReference) => getProjectStore().linkBoard(projectId, board));
  ipcMain.handle('projects:unlinkBoard', (_event, projectId: string, connectionId: string, boardId: string) => getProjectStore().unlinkBoard(projectId, connectionId, boardId));
}
