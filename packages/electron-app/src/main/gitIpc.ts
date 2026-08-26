import { ipcMain } from 'electron';
import { checkoutGit, commitGit, createBranchGit, deleteBranchGit, fetchGit, getGitCommit, getGitDiff, getGitStatus, loadGitRepository, pullGit, pushGit, stageGit, unstageGit } from './gitService';

export function registerGitIpc(): void {
  ipcMain.handle('git:open', async (_event, repositoryPath?: string) => loadGitRepository(repositoryPath));
  ipcMain.handle('git:refresh', async (_event, repositoryPath: string) => loadGitRepository(repositoryPath, { force: true }));
  ipcMain.handle('git:status', async (_event, repositoryPath: string) => getGitStatus(repositoryPath));
  ipcMain.handle('git:getCommit', async (_event, repositoryPath: string, hash: string) => getGitCommit(repositoryPath, hash));
  ipcMain.handle('git:getDiff', async (_event, repositoryPath: string, hash: string, filePath?: string) => getGitDiff(repositoryPath, hash, filePath));
  ipcMain.handle('git:stage', async (_event, repositoryPath: string, paths: string[]) => stageGit(repositoryPath, paths));
  ipcMain.handle('git:unstage', async (_event, repositoryPath: string, paths: string[]) => unstageGit(repositoryPath, paths));
  ipcMain.handle('git:commit', async (_event, repositoryPath: string, message: string) => commitGit(repositoryPath, message));
  ipcMain.handle('git:createBranch', async (_event, repositoryPath: string, name: string, startPoint?: string) => createBranchGit(repositoryPath, name, startPoint));
  ipcMain.handle('git:checkout', async (_event, repositoryPath: string, name: string) => checkoutGit(repositoryPath, name));
  ipcMain.handle('git:deleteBranch', async (_event, repositoryPath: string, name: string) => deleteBranchGit(repositoryPath, name));
  ipcMain.handle('git:pull', async (_event, repositoryPath: string) => pullGit(repositoryPath));
  ipcMain.handle('git:fetch', async (_event, repositoryPath: string) => fetchGit(repositoryPath));
  ipcMain.handle('git:push', async (_event, repositoryPath: string) => pushGit(repositoryPath));
}
