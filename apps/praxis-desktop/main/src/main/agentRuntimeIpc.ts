import { ipcMain } from 'electron';
import type { CatalogScope, NewAgentInput, NewSkillInput } from '@praxis/core';
import { getAgentRuntimeManager, getAgentRuntimeRoots } from './agentRuntimeInstance';
import { createAgent, createSkill, importItem, previewImport } from './agentRuntimeAuthoring';

export function registerAgentRuntimeIpc(): void {
  ipcMain.handle('agentRuntime:list', () => getAgentRuntimeManager().list());
  ipcMain.handle('agentRuntime:refresh', () => getAgentRuntimeManager().refresh());
  ipcMain.handle('agentRuntime:start', (_event, agentId: string) => getAgentRuntimeManager().start(agentId));
  ipcMain.handle('agentRuntime:stop', (_event, agentId: string) => getAgentRuntimeManager().stop(agentId));
  ipcMain.handle('agentRuntime:restart', (_event, agentId: string) => getAgentRuntimeManager().restart(agentId));
  ipcMain.handle('agentRuntime:roots', () => getAgentRuntimeRoots());
  ipcMain.handle('agentRuntime:activateSkill', (_event, agentId: string, skillName: string) =>
    getAgentRuntimeManager().activateSkill(agentId, skillName)
  );
  ipcMain.handle('agentRuntime:createAgent', (_event, input: NewAgentInput) => createAgent(input));
  ipcMain.handle('agentRuntime:createSkill', (_event, input: NewSkillInput) => createSkill(input));
  ipcMain.handle('agentRuntime:previewImport', (_event, kind: 'agent' | 'skill', sourceDir: string, scope: CatalogScope) =>
    previewImport(kind, sourceDir, scope)
  );
  ipcMain.handle(
    'agentRuntime:importItem',
    (_event, kind: 'agent' | 'skill', sourceDir: string, scope: CatalogScope, onDuplicate: 'block' | 'rename') =>
      importItem(kind, sourceDir, scope, onDuplicate)
  );
}
