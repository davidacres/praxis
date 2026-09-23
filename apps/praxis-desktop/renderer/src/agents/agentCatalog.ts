/**
 * Browser-safe Agent Hub view-model helpers.
 *
 * A renderer-local copy of core's `agentCatalog` (same reason as `workflowEdits`:
 * the renderer may import only *types* from `@praxis/core` at runtime). Discovery
 * itself still runs in the main process; these only shape the snapshot it returns.
 */

import type {
  AgentCapabilities,
  AgentRuntimeSnapshot,
  CatalogScope,
  DiscoveredAgent,
  DiscoveredAgentProfile,
  DiscoveredSkill
} from '@praxis/core';

export interface CatalogGroup {
  scope: CatalogScope;
  label: string;
  /** Executable runtime hosts (legacy property name retained by snapshot). */
  agents: DiscoveredAgent[];
  profiles: DiscoveredAgentProfile[];
  skills: DiscoveredSkill[];
}

const SCOPE_LABEL: Record<CatalogScope, string> = { global: 'Global', project: 'This project' };

export function groupCatalog(snapshot: Pick<AgentRuntimeSnapshot, 'agents' | 'runtimeHosts' | 'profiles' | 'skills'>): CatalogGroup[] {
  const order: CatalogScope[] = ['global', 'project'];
  return order
    .map(scope => ({
      scope,
      label: SCOPE_LABEL[scope],
      agents: (snapshot.runtimeHosts ?? snapshot.agents).filter(agent => agent.scope === scope),
      profiles: (snapshot.profiles ?? []).filter(profile => profile.scope === scope),
      skills: snapshot.skills.filter(skill => skill.scope === scope)
    }))
    .filter(group => group.agents.length > 0 || group.profiles.length > 0 || group.skills.length > 0);
}

export function agentStartBlockedReason(agent: DiscoveredAgent): string | undefined {
  if (agent.errors.length > 0) return `Manifest is invalid: ${agent.errors.map(error => error.message).join('; ')}`;
  if (!agent.trusted) {
    return agent.scope === 'project'
      ? 'Project agents are approval-required — move it to the global agents folder to start it here.'
      : 'This agent is not trusted yet.';
  }
  return undefined;
}

export function skillActivateBlockedReason(skill: DiscoveredSkill, agents: DiscoveredAgent[]): string | undefined {
  if (skill.error) return `Skill is invalid: ${skill.error}`;
  if (!skill.trusted) return 'Approval-required skills cannot be activated from the catalog.';
  if (!agents.some(agent => agentStartBlockedReason(agent) === undefined)) {
    return 'No trusted, valid agent is available to activate this skill.';
  }
  return undefined;
}

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

export function describeCapabilities(
  caps: AgentCapabilities | undefined
): { features: string[]; model?: string; version?: string } | undefined {
  if (!caps) return undefined;
  const features = CAPABILITY_LABELS.filter(([key]) => caps[key] === true).map(([, label]) => label);
  return {
    features,
    ...(caps.model ? { model: caps.model } : {}),
    ...(caps.version ? { version: caps.version } : {})
  };
}

export function agentHostStarted(snapshot: Pick<AgentRuntimeSnapshot, 'capabilities'>, agentId: string): boolean {
  return Object.prototype.hasOwnProperty.call(snapshot.capabilities, agentId);
}

export function hostRuntimeState(
  snapshot: Pick<AgentRuntimeSnapshot, 'hosts'>,
  agentId: string
): 'running' | 'failed' | 'stopped' {
  return snapshot.hosts[agentId]?.state ?? 'stopped';
}

export function runningHostCount(snapshot: Pick<AgentRuntimeSnapshot, 'hosts'>): number {
  return Object.values(snapshot.hosts).filter(status => status.state === 'running').length;
}

/**
 * True for the placeholder profile the backend auto-synthesizes (see
 * `AgentRuntimeManager.refresh`) for a launch binding that has no AGENT.md —
 * `fingerprint: 'legacy-host-profile'` is its literal marker. Every binding
 * always gets *some* profile entry this way, so `profile.legacy` alone can't
 * tell a genuine curated-but-old `brief.md` profile from a raw, uncurated
 * binding; the fingerprint can.
 */
export function isHostShimProfile(profile: DiscoveredAgentProfile): boolean {
  return profile.fingerprint === 'legacy-host-profile';
}

/** Transport → short human label. */
export function transportLabel(type: DiscoveredAgent['manifest']['type']): string {
  const labels: Record<DiscoveredAgent['manifest']['type'], string> = {
    acp: 'ACP',
    'copilot-sdk': 'Copilot SDK',
    http: 'HTTP',
    gateway: 'Gateway',
    custom: 'Custom'
  };
  return labels[type] ?? type;
}

/**
 * A skill's display name: its `title`, else its identifier in title case
 * (`praxis-test-contracts` → `Praxis Test Contracts`).
 */
export function skillTitle(metadata: { name: string; title?: string }): string {
  if (metadata.title?.trim()) return metadata.title.trim();
  return metadata.name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}
