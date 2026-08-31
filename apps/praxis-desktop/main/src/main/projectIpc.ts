import { app, ipcMain } from 'electron';
import type { AttachProjectFolderInput, Connection, CreateProjectInput, ProjectBoardReference, ProjectRecord, UpdateProjectInput } from '@praxis/core';
import { getProjectManager, getProjectStore } from './projectStoreInstance';
import { getWorkspaceStore } from './workspaceStoreInstance';
import { getConnectionStore } from './connectionStoreInstance';

/**
 * Existing folders are already the source of truth for their planning files.
 * Register that source as a read-only folder connection so the project has a
 * board backed by the files on disk rather than an empty Praxis-owned board.
 *
 * Only for `storage: 'app'` projects. A folder-backed project's *own* board
 * already reads those files, so adding this connection would produce two boards
 * over one folder — and the sidebar, seeing a `project-plans-*` link, would
 * suppress the project's own board as "the empty Praxis board" and show the
 * duplicate instead. That suppression predates `ProjectRecord.storage`.
 */
async function connectDetectedPlans(project: ProjectRecord): Promise<ProjectRecord> {
  const folder = project.workspaceFolder;
  if (project.storage === 'folder' || !folder || !(project.folderInspection?.planFiles?.length)) {
    return project;
  }

  const connections = getConnectionStore();
  const connection: Connection = {
    id: `project-plans-${project.id}`,
    name: `${project.name} plans`,
    mode: 'folder',
    settings: {
      roots: [folder],
      projectKey: project.key,
      projectName: project.name,
      // Imported plans stay safe/read-only until the user explicitly enables
      // writing in the Connections screen.
      allowIssueCreation: false
    }
  };
  await connections.addConnection(connection);
  try {
    const board = { connectionId: connection.id, boardId: `folder-${project.key.toLowerCase()}`, displayName: project.name };
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
  ipcMain.handle('projects:listDocuments', (_event, projectId: string) => getProjectManager().listDocuments(projectId));
  ipcMain.handle('projects:readDocument', (_event, projectId: string, relativePath: string) => getProjectManager().readDocument(projectId, relativePath));
}
