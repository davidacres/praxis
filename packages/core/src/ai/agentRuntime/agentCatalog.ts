/**
 * Pure view-model helpers for the Agent Hub (FX-BF-009).
 *
 * The renderer only imports types from core, so the fail-closed rules ("can this
 * agent be started?", "can this skill be activated?") and the capability summary
 * live here where they can be unit-tested, and the UI just renders the result.
 */

import type { CatalogScope, DiscoveredAgent } from './manifest';
import type { DiscoveredSkill } from './skillRegistry';
import type { DiscoveredAgentProfile } from './profileRegistry';
import type { AgentCapabilities } from './hostLoader';
import type { AgentRuntimeSnapshot } from './manager';

/** One catalog scope with its agents and skills, newest discovery order preserved. */
export interface CatalogGroup {
  scope: CatalogScope;
  label: string;
  /** Executable runtime hosts (legacy property name retained by snapshot). */
  agents: DiscoveredAgent[];
  profiles: DiscoveredAgentProfile[];
  skills: DiscoveredSkill[];
}

const SCOPE_LABEL: Record<CatalogScope, string> = { global: 'Global', project: 'This project' };

/** Splits a snapshot into Global / project groups, dropping empty ones. */
export function groupCatalog(snapshot: Pick<AgentRuntimeSnapshot, 'agents' | 'profiles' | 'skills'>): CatalogGroup[] {
  const order: CatalogScope[] = ['global', 'project'];
  return order
    .map(scope => ({
      scope,
      label: SCOPE_LABEL[scope],
      agents: snapshot.runtimeHosts.filter(agent => agent.scope === scope),
      profiles: snapshot.profiles.filter(profile => profile.scope === scope),
      skills: snapshot.skills.filter(skill => skill.scope === scope)
    }))
    .filter(group => group.agents.length > 0 || group.profiles.length > 0 || group.skills.length > 0);
}

/** Why this agent's host may not be started, or undefined when it is safe to. */
export function agentStartBlockedReason(agent: DiscoveredAgent): string | undefined {
  if (agent.errors.length > 0) return `Manifest is invalid: ${agent.errors.map(error => error.message).join('; ')}`;
  if (!agent.trusted) {
    return agent.scope === 'project'
      ? 'Project agents are approval-required — move it to the global agents folder to start it here.'
      : 'This agent is not trusted yet.';
  }
  return undefined;
}

/** Why this skill cannot be activated, or undefined when at least one agent can take it. */
export function skillActivateBlockedReason(skill: DiscoveredSkill, agents: DiscoveredAgent[]): string | undefined {
  if (skill.error) return `Skill is invalid: ${skill.error}`;
  if (!skill.trusted) return 'Approval-required skills cannot be activated from the catalog.';
  if (!agents.some(agent => agentStartBlockedReason(agent) === undefined)) {
    return 'No trusted, valid agent is available to activate this skill.';
  }
  return undefined;
}

/** The agents a skill could be activated against right now. */
export function eligibleAgentsForSkill(skill: DiscoveredSkill, agents: DiscoveredAgent[]): DiscoveredAgent[] {
  if (skill.error || !skill.trusted) return [];
  return agents.filter(agent => agentStartBlockedReason(agent) === undefined);
}

const CAPABILITY_LABELS: Array<[keyof AgentCapabilities, string]> = [
  ['supportsSkills', 'skills'],
  ['supportsTools', 'tools'],
  ['supportsMemory', 'memory'],
  ['supportsResume', 'resume'],
  ['supportsStreaming', 'streaming']
];

/**
 * A renderer-safe capability summary. Returns undefined when the host has not
 * been started (no capabilities reported yet), otherwise the enabled feature
 * words plus any model/version string.
 */
export function describeCapabilities(caps: AgentCapabilities | undefined): { features: string[]; model?: string; version?: string } | undefined {
  if (!caps) return undefined;
  const features = CAPABILITY_LABELS.filter(([key]) => caps[key] === true).map(([, label]) => label);
  return {
    features,
    ...(caps.model ? { model: caps.model } : {}),
    ...(caps.version ? { version: caps.version } : {})
  };
}

/** True once the runtime has reported capabilities for this agent (i.e. its host ran). */
export function agentHostStarted(snapshot: Pick<AgentRuntimeSnapshot, 'capabilities'>, agentId: string): boolean {
  return Object.prototype.hasOwnProperty.call(snapshot.capabilities, agentId);
}

/** 'running' | 'failed' | 'stopped' — the lifecycle state of an agent's host. */
export function hostRuntimeState(
  snapshot: Pick<AgentRuntimeSnapshot, 'hosts'>,
  agentId: string
): 'running' | 'failed' | 'stopped' {
  return snapshot.hosts[agentId]?.state ?? 'stopped';
}

/** How many hosts are currently running. */
export function runningHostCount(snapshot: Pick<AgentRuntimeSnapshot, 'hosts'>): number {
  return Object.values(snapshot.hosts).filter(status => status.state === 'running').length;
}
