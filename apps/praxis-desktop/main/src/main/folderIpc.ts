import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import {
  discoverPlanFolders,
  discoverRepositoryFolders,
  ensureFrontMatter,
  parsePlanFolder,
  readBoardConfigFile,
  resolvePlanDependencyKeys,
  writeBoardConfigFile,
  type BoardConfigFile,
  type IssueType,
  type ProjectWorkflowStage
} from '@praxis/core';
import { getConnectionStore } from './connectionStoreInstance';
import { ElectronFolderConfigProvider } from './adapters/electronFolderConfigProvider';
import { getRustHostBridge } from './rustHostInstance';

export function registerFolderIpc(): void {
  const bridge = getRustHostBridge();

  const discoverPlansFallback = async (_event: unknown, connectionId: string) => {
    const connection = getConnectionStore().getConnection(connectionId);
    if (!connection || connection.mode !== 'folder') {
      throw new Error(`Connection ${connectionId} is not a folder connection.`);
    }
    const roots = new ElectronFolderConfigProvider(connection).getFolderRoots();
    if (roots.length === 0) {
      throw new Error(`Folder connection ${connectionId} has no folders configured.`);
    }
    // Union every configured root's plans folders, de-duplicated by path.
    const seen = new Set<string>();
    const discovered = [];
    for (const root of roots) {
      for (const match of await discoverPlanFolders(root)) {
        if (seen.has(match.plansRootPath.toLowerCase())) {
          continue;
        }
        seen.add(match.plansRootPath.toLowerCase());
        discovered.push(match);
      }
    }
    return discovered;
  };

  const parsePlanFolderFallback = async (
    _event: unknown,
    root: string,
    workflow?: readonly ProjectWorkflowStage[] | null,
    projectKey = 'LIVE'
  ) => {
    const parsed = await parsePlanFolder(root, undefined, workflow ?? undefined);
    const dependencyKeys = Object.fromEntries(
      resolvePlanDependencyKeys(parsed, projectKey).entries()
    );
    return { parsed, dependencyKeys };
  };

  const writeBoardConfigFallback = async (
    _event: unknown,
    root: string,
    config: BoardConfigFile
  ) => {
    await writeBoardConfigFile(root, config);
    return true;
  };

  const ensureFrontMatterFallback = async (
    _event: unknown,
    content: string,
    kind?: IssueType | string
  ) => {
    const issueType = typeof kind === 'string' ? (kind as IssueType) : (kind ?? 'Task');
    return ensureFrontMatter(content ?? '', issueType);
  };

  bridge.handleOrFallback('folder:discoverPlans', discoverPlansFallback, ipcMain);
  bridge.handleOrFallback('plans:discoverPlans', discoverPlansFallback, ipcMain);

  bridge.handleOrFallback(
    'folder:discoverPlanFolders',
    async (_event, root: string) => discoverPlanFolders(root),
    ipcMain
  );
  bridge.handleOrFallback(
    'plans:discoverPlanFolders',
    async (_event, root: string) => discoverPlanFolders(root),
    ipcMain
  );

  bridge.handleOrFallback(
    'folder:discoverRepositoryFolders',
    async (_event, root: string) => discoverRepositoryFolders(root),
    ipcMain
  );

  bridge.handleOrFallback('folder:parsePlanFolder', parsePlanFolderFallback, ipcMain);
  bridge.handleOrFallback('plans:parsePlanFolder', parsePlanFolderFallback, ipcMain);

  bridge.handleOrFallback(
    'folder:readBoardConfig',
    async (_event, root: string) => readBoardConfigFile(root),
    ipcMain
  );
  bridge.handleOrFallback(
    'plans:readBoardConfig',
    async (_event, root: string) => readBoardConfigFile(root),
    ipcMain
  );

  bridge.handleOrFallback('folder:writeBoardConfig', writeBoardConfigFallback, ipcMain);
  bridge.handleOrFallback('plans:writeBoardConfig', writeBoardConfigFallback, ipcMain);

  bridge.handleOrFallback('folder:ensureFrontMatter', ensureFrontMatterFallback, ipcMain);
  bridge.handleOrFallback('plans:ensureFrontMatter', ensureFrontMatterFallback, ipcMain);
}
