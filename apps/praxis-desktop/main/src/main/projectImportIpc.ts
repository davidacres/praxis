import { app, ipcMain } from 'electron';
import {
  discoverPlanFolders,
  discoverRepositoryFolders,
  planProjectImports,
  validateProjectImports,
  writeBoardConfigFile,
  validateProjectRecord
} from '@praxis/core';
import type { ProjectImportRow, ProjectRecord } from '@praxis/core';
import { getProjectStore } from './projectStoreInstance';
import { getWorkspaceStore } from './workspaceStoreInstance';
import { syncProjectConnection } from './projectIpc';

/**
 * Importing existing plans folders as projects — the flow that replaced the
 * User Workspace connection's "create board" wizard.
 *
 * A folder full of markdown plans becomes a `storage: 'folder'` project, so the
 * files on disk stay the source of truth and the project's board reads them
 * directly. Records are built here rather than through `ProjectManager.create`
 * because none of its scaffolding applies: the folder already exists, already
 * holds plans, and must not be seeded with starter tickets.
 */
export function registerProjectImportIpc(): void {
  ipcMain.handle(
    'projects:discoverImports',
    async (_event, folderPath: string): Promise<ProjectImportRow[]> => {
      const [planRoots, repositoryPaths] = await Promise.all([
        discoverPlanFolders(folderPath),
        discoverRepositoryFolders(folderPath)
      ]);
      const projects = getProjectStore().list();
      return planProjectImports({
        repositories: repositoryPaths.map(rootPath => ({ rootPath })),
        planRoots: planRoots.map(match => ({
          plansPath: match.plansRootPath,
          featureEntryCount: match.featureEntries.length
        })),
        // Folder-backed projects already pointing at a plans folder are flagged
        // as added so a second import never duplicates them.
        existingPaths: projects
          .filter(project => project.storage === 'folder')
          .map(project => project.workspaceFolder)
          .filter((value): value is string => !!value),
        existingKeys: projects.map(project => project.key)
      });
    }
  );

  ipcMain.handle(
    'projects:validateImports',
    (_event, rows: ProjectImportRow[]): string | undefined =>
      validateProjectImports(rows, getProjectStore().list().map(project => project.key))
  );

  ipcMain.handle(
    'projects:createFromImports',
    async (_event, rows: ProjectImportRow[], workspaceId: string): Promise<ProjectRecord[]> => {
      const workspaces = getWorkspaceStore();
      if (!workspaceId?.trim() || !workspaces.get(workspaceId)) {
        throw new Error('Open a valid workspace before importing projects.');
      }
      const validationError = validateProjectImports(
        rows,
        getProjectStore().list().map(project => project.key)
      );
      if (validationError) {
        throw new Error(validationError);
      }

      const store = getProjectStore();
      const created: ProjectRecord[] = [];
      for (const row of rows) {
        if (row.alreadyAdded) {
          continue;
        }
        const now = new Date().toISOString();
        const id = `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const project: ProjectRecord = {
          id,
          name: row.projectName.trim(),
          key: row.projectKey.trim().toUpperCase(),
          type: 'software',
          purpose: '',
          brief: {},
          storage: 'folder',
          workspaceFolder: row.plansFolderPath,
          // The folder's markdown statuses drive the board; these stages exist
          // only to satisfy the record shape.
          workflowStages: [
            { id: `${id}-backlog`, name: 'Backlog' },
            { id: `${id}-done`, name: 'Done' }
          ],
          defaultBoardId: `${id}-board`,
          // Empty by construction: a folder-backed project never reads these.
          workItems: [],
          linkedBoards: [],
          defaultAiToolMode: 'full',
          createdAt: now,
          updatedAt: now,
          projectFileStatus: 'retained'
        };
        validateProjectRecord(project);
        created.push(await syncProjectConnection(await store.create(project)));
        // Write the project's identity into the folder's `board.praxis.json`
        // so the plans travel self-describing — re-importing the same folder
        // elsewhere then recovers the key and name rather than guessing.
        await writeBoardConfigFile(row.plansFolderPath, {
          projectKey: project.key,
          projectName: project.name
        }).catch(() => undefined);
      }

      if (created.length > 0) {
        const workspace = workspaces.get(workspaceId);
        if (!workspace) {
          throw new Error(`Workspace ${workspaceId} was not found.`);
        }
        await workspaces.update(
          workspaceId,
          {
            projectIds: [...workspace.projectIds, ...created.map(project => project.id)],
            defaultProjectId: workspace.defaultProjectId ?? created[0].id
          },
          app.getVersion()
        );
      }
      return created;
    }
  );
}
