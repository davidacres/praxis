import { app, ipcMain } from 'electron';
import type { AttachProjectFolderInput, CreateProjectInput, ProjectBoardReference, ProjectRecord, UpdateProjectInput } from '@praxis/core';
import { getProjectManager, getProjectStore } from './projectStoreInstance';
import { getWorkspaceStore } from './workspaceStoreInstance';
import { getConnectionStore } from './connectionStoreInstance';
import { FolderService, buildProjectConnection, discoverPlanFolders, projectConnectionId } from '@praxis/core';
import { getServiceForConnection } from './serviceRegistry';

/**
 * Ensures every project has a real connection. Once created, the connection is
 * the source of truth for its backend settings and can be managed like any
 * other connection; this only rewrites it for an explicit storage transition
 * or to migrate the legacy synthetic project backend.
 */
export async function syncProjectConnection(project: ProjectRecord, force = false): Promise<ProjectRecord> {
  const connections = getConnectionStore();
  if (project.planningMode === 'files') {
    const existing = connections.getConnection(projectConnectionId(project.id));
    if (existing) {
      for (const board of connections.getTrackedBoardsForConnection(existing.id)) {
        await connections.removeTrackedBoard({ connectionId: existing.id, boardId: board.boardId });
      }
      await connections.removeConnection(existing.id);
    }
    return project;
  }
  const connection = buildProjectConnection(project);
  const existing = connections.getConnection(connection.id);
  if (existing?.mode === connection.mode && force) {
    await connections.updateConnection(connection);
  } else if (existing?.mode === connection.mode) {
    await connections.addTrackedBoard({
      connectionId: connection.id,
      boardId: connection.mode === 'folder' ? `folder-${project.key.toLowerCase()}` : project.defaultBoardId,
      displayName: project.name
    });
    return project;
  } else if (existing) {
    for (const board of connections.getTrackedBoardsForConnection(existing.id)) {
      await connections.removeTrackedBoard({ connectionId: existing.id, boardId: board.boardId });
    }
    await connections.removeConnection(existing.id);
    await connections.addConnection(connection);
  } else {
    await connections.addConnection(connection);
  }
  await connections.addTrackedBoard({
    connectionId: connection.id,
    boardId: connection.mode === 'folder' ? `folder-${project.key.toLowerCase()}` : project.defaultBoardId,
    displayName: project.name
  });
  return project;
}

/**
 * Startup heal for projects written before this model settled. Two eras:
 *
 * 1. Before `ProjectRecord.storage` existed, every project was built as app
 *    storage — so one pointed at a folder of markdown plans showed an empty
 *    board while the plans sat on disk. A record with no `storage`, a folder
 *    that holds plans, and zero work items is exactly that artifact; flip it to
 *    folder-backed. A record with work items keeps app storage (it holds real
 *    data), and one whose folder has no plans is stamped `app` so it is never
 *    re-scanned.
 * 2. Before projects owned a connection row, their boards were the only ones
 *    that could not be resolved from the connection list. Every project gets
 *    its row here, whatever its era.
 */
export async function healLegacyFolderProjects(): Promise<void> {
  const store = getProjectStore();
  for (const project of store.list()) {
    let healed = project;
    if (project.storage === undefined && project.workspaceFolder && project.workItems.length === 0) {
      try {
        const roots = await discoverPlanFolders(project.workspaceFolder);
        const storage = roots.length > 0 ? 'folder' as const : 'app' as const;
        // Retire the old companion connection, which duplicated this project’s
        // real folder connection rather than representing a distinct source.
        const companionId = `project-plans-${project.id}`;
        const linkedBoards = storage === 'folder'
          ? project.linkedBoards.filter(link => link.connectionId !== companionId)
          : project.linkedBoards;
        healed = await store.replace({ ...project, storage, linkedBoards, updatedAt: new Date().toISOString() });
        if (storage === 'folder') {
          const companion = getConnectionStore().getConnection(companionId);
          if (companion) {
            for (const board of getConnectionStore().getTrackedBoardsForConnection(companionId)) {
              await getConnectionStore().removeTrackedBoard({ connectionId: companionId, boardId: board.boardId });
            }
            await getConnectionStore().removeConnection(companionId).catch(() => undefined);
          }
          console.log(`projects — healed "${project.name}" to folder-backed (${project.workspaceFolder})`);
        }
      } catch {
        // An unreadable folder (unplugged drive) is left untouched for next launch.
      }
    }
    await syncProjectConnection(healed).catch(error =>
      console.error(`projects — could not write the connection for "${healed.name}":`, error));
  }
}

export function registerProjectIpc(): void {
  void healLegacyFolderProjects().catch(error =>
    console.error('projects — legacy storage heal failed:', error));
  ipcMain.handle('projects:list', () => getProjectManager().list());
  ipcMain.handle('projects:get', (_event, projectId: string) => getProjectManager().get(projectId));
  ipcMain.handle('projects:create', async (_event, input: CreateProjectInput, workspaceId: string) =>
    syncProjectConnection(await getProjectManager().createInWorkspace(
      input, workspaceId, getWorkspaceStore(), app.getVersion()
    )));
  ipcMain.handle('projects:useExisting', (_event, projectId: string, workspaceId: string) =>
    getProjectManager().useInWorkspace(projectId, workspaceId, getWorkspaceStore(), app.getVersion()));
  ipcMain.handle('projects:remove', async (_event, projectId: string) => {
    const connections = getConnectionStore();
    const ownedConnection = connections.getConnections().find(
      connection => connection.settings.projectId === projectId
    );
    if (ownedConnection) {
      for (const board of connections.getTrackedBoardsForConnection(ownedConnection.id)) {
        await connections.removeTrackedBoard({ connectionId: ownedConnection.id, boardId: board.boardId });
      }
    }
    await getProjectStore().remove(projectId);
    if (ownedConnection) await connections.removeConnection(ownedConnection.id);
    for (const workspace of getWorkspaceStore().list()) {
      if (workspace.projectIds.includes(projectId)) {
        await getWorkspaceStore().update(workspace.id, {
          projectIds: workspace.projectIds.filter(id => id !== projectId),
          defaultProjectId: workspace.defaultProjectId === projectId ? undefined : workspace.defaultProjectId
        }, app.getVersion());
      }
    }
  });
  ipcMain.handle('projects:update', async (_event, projectId: string, patch: UpdateProjectInput) => {
    const updated = await getProjectStore().update(projectId, patch);
    if (patch.planningMode !== undefined) {
      await syncProjectConnection(updated, true);
    }
    // A folder-backed board's columns live in `board.praxis.json` so the
    // workflow travels with the folder (FX-BE-045). Best-effort, exactly like
    // the connection-edit path: an unreadable folder must not block the save.
    if (patch.workflowStages && updated.storage === 'folder') {
      try {
        const service = await getServiceForConnection(buildProjectConnection(updated).id);
        if (service instanceof FolderService) {
          await service.syncBoardConfigToFolder({ workflow: updated.workflowStages });
        }
      } catch {
        // Folder unreadable / not a plans folder — the record still saved.
      }
    }
    // project.praxis.md is generated, not frozen (FX-BE-047): regenerate it whenever
    // something it renders changes. Best-effort — the record has already saved.
    if ((patch.workflowStages || patch.purpose !== undefined || patch.brief) && updated.workspaceFolder) {
      try {
        await getProjectManager().refreshProjectFile(updated);
      } catch {
        // Folder gone or read-only — the record still saved.
      }
    }
    return updated;
  });
  ipcMain.handle('projects:inspectFolder', (_event, folderPath: string) => getProjectManager().inspectFolder(folderPath));
  ipcMain.handle('projects:attachFolder', async (_event, projectId: string, input: AttachProjectFolderInput) => {
    // An attached folder adds project files and tools; a project's connection
    // remains app-backed unless it was explicitly created as folder-backed.
    const result = await getProjectManager().attachFolder(projectId, input);
    await syncProjectConnection(result.project, true);
    return result;
  });
  ipcMain.handle('projects:linkBoard', (_event, projectId: string, board: ProjectBoardReference) => getProjectStore().linkBoard(projectId, board));
  ipcMain.handle('projects:unlinkBoard', (_event, projectId: string, connectionId: string, boardId: string) => getProjectStore().unlinkBoard(projectId, connectionId, boardId));
  ipcMain.handle('projects:listDocuments', (_event, projectId: string) => getProjectManager().listDocuments(projectId));
  ipcMain.handle('projects:readDocument', (_event, projectId: string, relativePath: string) => getProjectManager().readDocument(projectId, relativePath));
}
