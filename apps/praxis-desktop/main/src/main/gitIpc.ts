import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import { getRustHostBridge } from './rustHostInstance';
import {
  abortGitConflict,
  applyGitHunk,
  checkoutGit,
  cherryPickGit,
  cloneGitRepository,
  commitGit,
  createBranchGit,
  deleteBranchGit,
  discardGit,
  fetchGit,
  getGitBlame,
  getGitCommit,
  getGitComparison,
  getGitConflict,
  getGitDiff,
  getGitFileContent,
  getGitFileHistory,
  getGitStatus,
  loadGitRepository,
  mergeGit,
  popGitStash,
  pullGit,
  pushGit,
  rebaseGit,
  renameBranchGit,
  resolveGitConflict,
  revertGit,
  stageGit,
  stashGit,
  unstageGit,
  preflightGitRepository,
  initializeGitRepository
} from './gitService';

export function registerGitIpc(): void {
  const bridge = getRustHostBridge();

  bridge.handleOrFallback('git:preflight', async (_event, repositoryPath?: string) => preflightGitRepository(repositoryPath), ipcMain);
  bridge.handleOrFallback('git:initialize', async (_event, repositoryPath: string) => initializeGitRepository(repositoryPath), ipcMain);
  bridge.handleOrFallback('git:clone', async (_event, repositoryUrl: string, targetParent: string, targetName?: string) => cloneGitRepository(repositoryUrl, targetParent, targetName), ipcMain);
  bridge.handleOrFallback('git:open', async (_event, repositoryPath: string) => loadGitRepository(repositoryPath), ipcMain);
  bridge.handleOrFallback('git:refresh', async (_event, repositoryPath: string) => loadGitRepository(repositoryPath, { force: true }), ipcMain);
  bridge.handleOrFallback('git:status', async (_event, repositoryPath: string) => getGitStatus(repositoryPath), ipcMain);
  bridge.handleOrFallback('git:getCommit', async (_event, repositoryPath: string, hash: string) => getGitCommit(repositoryPath, hash), ipcMain);
  bridge.handleOrFallback('git:getDiff', async (_event, repositoryPath: string, hash: string, filePath?: string) => getGitDiff(repositoryPath, hash, filePath), ipcMain);
  bridge.handleOrFallback('git:getComparison', async (_event, repositoryPath: string, request: any) => getGitComparison(repositoryPath, request), ipcMain);
  bridge.handleOrFallback('git:applyHunk', async (_event, repositoryPath: string, request: any) => applyGitHunk(repositoryPath, request), ipcMain);
  bridge.handleOrFallback('git:stage', async (_event, repositoryPath: string, paths: string[]) => stageGit(repositoryPath, paths), ipcMain);
  bridge.handleOrFallback('git:unstage', async (_event, repositoryPath: string, paths: string[]) => unstageGit(repositoryPath, paths), ipcMain);
  bridge.handleOrFallback('git:discard', async (_event, repositoryPath: string, paths: string[]) => discardGit(repositoryPath, paths), ipcMain);
  bridge.handleOrFallback('git:commit', async (_event, repositoryPath: string, message: string) => commitGit(repositoryPath, message), ipcMain);
  bridge.handleOrFallback('git:createBranch', async (_event, repositoryPath: string, name: string, startPoint?: string) => createBranchGit(repositoryPath, name, startPoint), ipcMain);
  bridge.handleOrFallback('git:checkout', async (_event, repositoryPath: string, name: string) => checkoutGit(repositoryPath, name), ipcMain);
  bridge.handleOrFallback('git:deleteBranch', async (_event, repositoryPath: string, name: string) => deleteBranchGit(repositoryPath, name), ipcMain);
  bridge.handleOrFallback('git:renameBranch', async (_event, repositoryPath: string, oldName: string, newName: string) => renameBranchGit(repositoryPath, oldName, newName), ipcMain);
  bridge.handleOrFallback('git:merge', async (_event, repositoryPath: string, source: string) => mergeGit(repositoryPath, source), ipcMain);
  bridge.handleOrFallback('git:rebase', async (_event, repositoryPath: string, target: string) => rebaseGit(repositoryPath, target), ipcMain);
  bridge.handleOrFallback('git:getConflict', async (_event, repositoryPath: string, path: string) => getGitConflict(repositoryPath, path), ipcMain);
  bridge.handleOrFallback('git:resolveConflict', async (_event, repositoryPath: string, path: string, resolution: any) => resolveGitConflict(repositoryPath, path, resolution), ipcMain);
  bridge.handleOrFallback('git:abortConflict', async (_event, repositoryPath: string) => abortGitConflict(repositoryPath), ipcMain);
  bridge.handleOrFallback('git:getFileContent', async (_event, repositoryPath: string, path: string) => getGitFileContent(repositoryPath, path), ipcMain);
  bridge.handleOrFallback('git:getFileHistory', async (_event, repositoryPath: string, path: string, ref?: string) => getGitFileHistory(repositoryPath, path, ref), ipcMain);
  bridge.handleOrFallback('git:getBlame', async (_event, repositoryPath: string, path: string, ref?: string) => getGitBlame(repositoryPath, path, ref), ipcMain);
  bridge.handleOrFallback('git:cherryPick', async (_event, repositoryPath: string, commit: string) => cherryPickGit(repositoryPath, commit), ipcMain);
  bridge.handleOrFallback('git:revert', async (_event, repositoryPath: string, commit: string) => revertGit(repositoryPath, commit), ipcMain);
  bridge.handleOrFallback('git:stash', async (_event, repositoryPath: string, message?: string) => stashGit(repositoryPath, message), ipcMain);
  bridge.handleOrFallback('git:popStash', async (_event, repositoryPath: string) => popGitStash(repositoryPath), ipcMain);
  bridge.handleOrFallback('git:pull', async (_event, repositoryPath: string) => pullGit(repositoryPath), ipcMain);
  bridge.handleOrFallback('git:fetch', async (_event, repositoryPath: string) => fetchGit(repositoryPath), ipcMain);
  bridge.handleOrFallback('git:push', async (_event, repositoryPath: string) => pushGit(repositoryPath), ipcMain);
}
