import type { AgentTransport, DiscoveredAgent } from './agentRuntime/manifest';

export type AgentHostTransport = AgentTransport;
export type SkillActivationMode = 'native' | 'tools' | 'context';

export interface AgentProviderRef {
  id: string;
  model?: string;
}

export interface AgentHostCapabilities {
  supportsNativeProfiles?: boolean;
  supportsNativeSkills?: boolean;
  supportsTools?: boolean;
  supportsResume?: boolean;
  supportsModes?: boolean;
}

export interface AgentHostManifest {
  id: string;
  name: string;
  transport: AgentHostTransport;
  entry: string | { command?: string; args?: string[]; url?: string };
  providerIds?: string[];
  capabilities?: AgentHostCapabilities;
}

export interface AgentProfile {
  id: string;
  name: string;
  description?: string;
  instructions: string;
  preferredSkills?: string[];
  requiredCapabilities?: string[];
  toolMode?: 'read-only' | 'project-only' | 'full';
  version?: string;
}

export interface AgentSkillRef {
  id: string;
  version?: string;
  instructions: string;
  requiredTools?: string[];
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface AgentSkillActivation {
  skillId: string;
  mode: SkillActivationMode;
  reason: string;
  instructionsIncluded: boolean;
}

export interface AgentBinding {
  profile: AgentProfile;
  provider: AgentProviderRef;
  host: AgentHostManifest;
  skills: AgentSkillRef[];
  activations: AgentSkillActivation[];
}

/** Adapts a legacy agent.json record into the canonical runtime-host contract. */
export function toAgentHostManifest(agent: DiscoveredAgent): AgentHostManifest {
  return {
    id: agent.manifest.id,
    name: agent.manifest.name,
    transport: agent.manifest.type,
    entry: agent.manifest.entry
  };
}

/**
 * Plans a truthful fallback for each skill. Native mode is used only when the
 * host explicitly advertised it; otherwise instructions are preserved.
 */
export function planSkillActivations(
  skills: AgentSkillRef[],
  capabilities: AgentHostCapabilities
): AgentSkillActivation[] {
  return skills.map(skill => {
    if (capabilities.supportsNativeSkills) {
      return {
        skillId: skill.id,
        mode: 'native',
        reason: 'Runtime host explicitly advertises native skill support.',
        instructionsIncluded: false
      };
    }
    if (capabilities.supportsTools && (skill.requiredTools?.length ?? 0) > 0) {
      return {
        skillId: skill.id,
        mode: 'tools',
        reason: 'Runtime host supports tools but not native skill activation.',
        instructionsIncluded: true
      };
    }
    return {
      skillId: skill.id,
      mode: 'context',
      reason: 'No confirmed native skill activation path is available.',
      instructionsIncluded: true
    };
  });
}

/** Builds the portable instruction context used when native activation is unavailable. */
export function buildProfileContext(
  binding: Pick<AgentBinding, 'profile' | 'skills' | 'activations'>
): string {
  const sections = [
    `## Praxis agent profile: ${binding.profile.name}`,
    binding.profile.instructions
  ];
  for (const skill of binding.skills) {
    const activation = binding.activations.find(item => item.skillId === skill.id);
    if (!activation?.instructionsIncluded) continue;
    sections.push(`## Praxis skill: ${skill.id} (${activation.mode})`, skill.instructions);
  }
  return sections.filter(Boolean).join('\n\n');
}
