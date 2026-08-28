import { ipcMain } from 'electron';
import { abortGitConflict, applyGitHunk, checkoutGit, cherryPickGit, cloneGitRepository, commitGit, createBranchGit, deleteBranchGit, discardGit, fetchGit, getGitBlame, getGitCommit, getGitComparison, getGitConflict, getGitDiff, getGitFileHistory, getGitStatus, loadGitRepository, mergeGit, popGitStash, pullGit, pushGit, rebaseGit, renameBranchGit, resolveGitConflict, revertGit, stageGit, stashGit, unstageGit, preflightGitRepository, initializeGitRepository } from './gitService';

export function registerGitIpc(): void {
  ipcMain.handle('git:preflight', async (_event, repositoryPath?: string) => preflightGitRepository(repositoryPath));
  ipcMain.handle('git:initialize', async (_event, repositoryPath: string) => initializeGitRepository(repositoryPath));
  ipcMain.handle('git:clone', async (_event, repositoryUrl: string, targetParent: string, targetName?: string) => cloneGitRepository(repositoryUrl, targetParent, targetName));
  ipcMain.handle('git:open', async (_event, repositoryPath: string) => loadGitRepository(repositoryPath));
  ipcMain.handle('git:refresh', async (_event, repositoryPath: string) => loadGitRepository(repositoryPath, { force: true }));
  ipcMain.handle('git:status', async (_event, repositoryPath: string) => getGitStatus(repositoryPath));
  ipcMain.handle('git:getCommit', async (_event, repositoryPath: string, hash: string) => getGitCommit(repositoryPath, hash));
  ipcMain.handle('git:getDiff', async (_event, repositoryPath: string, hash: string, filePath?: string) => getGitDiff(repositoryPath, hash, filePath));
  ipcMain.handle('git:getComparison', async (_event, repositoryPath, request) => getGitComparison(repositoryPath, request));
  ipcMain.handle('git:applyHunk', async (_event, repositoryPath, request) => applyGitHunk(repositoryPath, request));
  ipcMain.handle('git:stage', async (_event, repositoryPath: string, paths: string[]) => stageGit(repositoryPath, paths));
  ipcMain.handle('git:unstage', async (_event, repositoryPath: string, paths: string[]) => unstageGit(repositoryPath, paths));
  ipcMain.handle('git:discard', async (_event, repositoryPath: string, paths: string[]) => discardGit(repositoryPath, paths));
  ipcMain.handle('git:commit', async (_event, repositoryPath: string, message: string) => commitGit(repositoryPath, message));
  ipcMain.handle('git:createBranch', async (_event, repositoryPath: string, name: string, startPoint?: string) => createBranchGit(repositoryPath, name, startPoint));
  ipcMain.handle('git:checkout', async (_event, repositoryPath: string, name: string) => checkoutGit(repositoryPath, name));
  ipcMain.handle('git:deleteBranch', async (_event, repositoryPath: string, name: string) => deleteBranchGit(repositoryPath, name));
  ipcMain.handle('git:renameBranch', async (_event, repositoryPath, oldName, newName) => renameBranchGit(repositoryPath, oldName, newName));
  ipcMain.handle('git:merge', async (_event, repositoryPath, source) => mergeGit(repositoryPath, source));
  ipcMain.handle('git:rebase', async (_event, repositoryPath, target) => rebaseGit(repositoryPath, target));
  ipcMain.handle('git:getConflict', async (_event, repositoryPath, path) => getGitConflict(repositoryPath, path));
  ipcMain.handle('git:resolveConflict', async (_event, repositoryPath, path, resolution) => resolveGitConflict(repositoryPath, path, resolution));
  ipcMain.handle('git:abortConflict', async (_event, repositoryPath) => abortGitConflict(repositoryPath));
  ipcMain.handle('git:getFileHistory', async (_event, repositoryPath, path, ref) => getGitFileHistory(repositoryPath, path, ref));
  ipcMain.handle('git:getBlame', async (_event, repositoryPath, path, ref) => getGitBlame(repositoryPath, path, ref));
  ipcMain.handle('git:cherryPick', async (_event, repositoryPath, commit) => cherryPickGit(repositoryPath, commit));
  ipcMain.handle('git:revert', async (_event, repositoryPath, commit) => revertGit(repositoryPath, commit));
  ipcMain.handle('git:stash', async (_event, repositoryPath, message) => stashGit(repositoryPath, message));
  ipcMain.handle('git:popStash', async (_event, repositoryPath) => popGitStash(repositoryPath));
  ipcMain.handle('git:pull', async (_event, repositoryPath: string) => pullGit(repositoryPath));
  ipcMain.handle('git:fetch', async (_event, repositoryPath: string) => fetchGit(repositoryPath));
  ipcMain.handle('git:push', async (_event, repositoryPath: string) => pushGit(repositoryPath));
}
