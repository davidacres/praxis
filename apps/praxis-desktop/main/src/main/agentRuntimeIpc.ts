import { ipcMain } from 'electron';
import { getAgentRuntimeManager } from './agentRuntimeInstance';

export function registerAgentRuntimeIpc(): void {
  ipcMain.handle('agentRuntime:list', () => getAgentRuntimeManager().list());
  ipcMain.handle('agentRuntime:refresh', () => getAgentRuntimeManager().refresh());
  ipcMain.handle('agentRuntime:start', (_event, agentId: string) => getAgentRuntimeManager().start(agentId));
  ipcMain.handle('agentRuntime:activateSkill', (_event, agentId: string, skillName: string) => getAgentRuntimeManager().activateSkill(agentId, skillName));
}
