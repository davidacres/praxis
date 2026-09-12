import * as path from 'node:path';
import { app } from 'electron';
import { AgentRuntimeManager, mirrorBundledAgents, type CatalogScope } from '@praxis/core';
import { getSettingsBackend } from './settingsBackendInstance';

let manager: AgentRuntimeManager | undefined;

export interface AgentRuntimeRoots {
  agents: Record<CatalogScope, string>;
  skills: Record<CatalogScope, string>;
}

/** The discovery roots for each catalog scope, derived the same way the manager is. */
export function getAgentRuntimeRoots(): AgentRuntimeRoots {
  const workingDirectory = getSettingsBackend().read().ai.workingDirectory.trim() || process.cwd();
  const projectRoot = path.join(workingDirectory, '.praxis');
  const userRoot = app.getPath('userData');
  return {
    agents: { global: path.join(userRoot, 'agents'), project: path.join(projectRoot, 'agents') },
    skills: { global: path.join(userRoot, 'skills'), project: path.join(projectRoot, 'skills') }
  };
}

/** Shared discovery registry for the desktop main process. Hosts are lazy; discovery never spawns them. */
export function getAgentRuntimeManager(): AgentRuntimeManager {
  if (!manager) {
    const roots = getAgentRuntimeRoots();
    void mirrorBundledAgents(roots.agents.global);
    manager = new AgentRuntimeManager({
      userAgentsPath: roots.agents.global,
      projectAgentsPath: roots.agents.project,
      allowProjectAgents: process.env.PRAXIS_ALLOW_PROJECT_AGENTS !== '0',
      includeBundled: true,
      skillRoots: [roots.skills.global, roots.skills.project],
      trustedSkillRoots: [roots.skills.global]
    });
  }
  return manager;
}
