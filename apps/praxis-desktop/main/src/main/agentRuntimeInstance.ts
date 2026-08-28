import * as path from 'node:path';
import { app } from 'electron';
import { AgentRuntimeManager } from '@praxis/core';
import { getSettingsBackend } from './settingsBackendInstance';

let manager: AgentRuntimeManager | undefined;

/** Shared discovery registry for the desktop main process. Hosts are lazy; discovery never spawns them. */
export function getAgentRuntimeManager(): AgentRuntimeManager {
  if (!manager) {
    const workingDirectory = getSettingsBackend().read().ai.workingDirectory.trim() || process.cwd();
    const projectRoot = path.join(workingDirectory, '.ticket-manager');
    const userRoot = app.getPath('userData');
    manager = new AgentRuntimeManager({
      userAgentsPath: path.join(userRoot, 'agents'),
      projectAgentsPath: path.join(projectRoot, 'agents'),
      allowProjectAgents: process.env.TICKET_MANAGER_ALLOW_PROJECT_AGENTS !== '0',
      skillRoots: [path.join(userRoot, 'skills'), path.join(projectRoot, 'skills')],
      trustedSkillRoots: [path.join(userRoot, 'skills')]
    });
  }
  return manager;
}
