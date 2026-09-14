import { discoverAgents, type DiscoveryOptions } from './discovery';
import type { DiscoveredAgent } from './manifest';
import { discoverSkills, loadSkillInstructions, type DiscoveredSkill } from './skillRegistry';
import { discoverAgentProfiles, type DiscoveredAgentProfile } from './profileRegistry';
import { loadAgentHost, type AgentCapabilities, type AgentHostHandle } from './hostLoader';
import {
  buildProfileContext,
  planSkillActivations,
  toAgentHostManifest,
  type AgentBinding,
  type AgentProviderRef,
  type AgentSkillRef
} from '../agentContracts';

export interface HostRuntimeStatus {
  state: 'running' | 'failed';
  startedAt: string;
  pid?: number;
  error?: string;
}

export interface AgentRuntimeSnapshot {
  /** @deprecated Use runtimeHosts. Kept for persisted/UI compatibility. */
  agents: DiscoveredAgent[];
  runtimeHosts: DiscoveredAgent[];
  profiles: DiscoveredAgentProfile[];
  skills: DiscoveredSkill[];
  capabilities: Record<string, AgentCapabilities>;
  hosts: Record<string, HostRuntimeStatus>;
  refreshedAt: string;
}

export interface AgentRuntimeManagerOptions extends DiscoveryOptions {
  skillRoots?: string[];
  trustedSkillRoots?: string[];
  profileRoots?: string[];
  trustedProfileRoots?: string[];
}

export interface ActivatedSkill {
  /** @deprecated Use hostId. */
  agentId: string;
  hostId: string;
  skill: DiscoveredSkill;
  mode: 'native' | 'context' | 'tools';
  instructions: string;
}

export class AgentRuntimeManager {
  private snapshot: AgentRuntimeSnapshot = {
    agents: [],
    runtimeHosts: [],
    profiles: [],
    skills: [],
    capabilities: {},
    hosts: {},
    refreshedAt: ''
  };
  private readonly hosts = new Map<string, AgentHostHandle>();
  private readonly hostStatus = new Map<string, HostRuntimeStatus>();

  public constructor(private readonly options: AgentRuntimeManagerOptions) {}

  public async refresh(): Promise<AgentRuntimeSnapshot> {
    const profileRoots = this.options.profileRoots ?? [
      ...(this.options.userAgentsPath ? [this.options.userAgentsPath] : []),
      ...(this.options.allowProjectAgents && this.options.projectAgentsPath ? [this.options.projectAgentsPath] : [])
    ];
    const [runtimeHosts, profiles, skills] = await Promise.all([
      discoverAgents(this.options),
      discoverAgentProfiles(
        profileRoots,
        this.options.trustedProfileRoots ?? (this.options.userAgentsPath ? [this.options.userAgentsPath] : profileRoots),
        this.options.includeBundled === true
      ),
      discoverSkills(
        this.options.skillRoots ?? [],
        this.options.trustedSkillRoots ?? this.options.skillRoots ?? []
      )
    ]);
    this.snapshot = {
      agents: runtimeHosts,
      runtimeHosts,
      profiles,
      skills,
      capabilities: Object.fromEntries([...this.hosts].map(([id, host]) => [id, host.capabilities])),
      hosts: Object.fromEntries(this.hostStatus),
      refreshedAt: new Date().toISOString()
    };
    return this.snapshot;
  }

  public async start(hostId: string): Promise<AgentRuntimeSnapshot> {
    const hostDefinition = (await this.list()).runtimeHosts.find(candidate => candidate.manifest.id === hostId);
    if (!hostDefinition) throw new Error(`Runtime host ${hostId} was not discovered.`);
    await this.hosts.get(hostId)?.dispose();
    this.hosts.delete(hostId);
    try {
      const host = await loadAgentHost(hostDefinition);
      this.hosts.set(hostId, host);
      this.hostStatus.set(hostId, {
        state: 'running',
        startedAt: new Date().toISOString(),
        ...(host.process?.pid ? { pid: host.process.pid } : {})
      });
    } catch (cause) {
      this.hostStatus.set(hostId, {
        state: 'failed',
        startedAt: new Date().toISOString(),
        error: cause instanceof Error ? cause.message : String(cause)
      });
      await this.refresh();
      throw cause;
    }
    return this.refresh();
  }

  public async stop(hostId: string): Promise<AgentRuntimeSnapshot> {
    await this.hosts.get(hostId)?.dispose();
    this.hosts.delete(hostId);
    this.hostStatus.delete(hostId);
    return this.refresh();
  }

  public async restart(hostId: string): Promise<AgentRuntimeSnapshot> {
    await this.stop(hostId);
    return this.start(hostId);
  }

  public async activateSkill(hostId: string, skillName: string): Promise<ActivatedSkill> {
    const snapshot = await this.list();
    const skill = snapshot.skills.find(candidate => candidate.metadata.name === skillName);
    if (!skill) throw new Error(`Skill ${skillName} was not discovered.`);
    if (skill.error) throw new Error(`Skill ${skillName} is invalid: ${skill.error}`);
    const hostDefinition = snapshot.runtimeHosts.find(candidate => candidate.manifest.id === hostId);
    if (!hostDefinition) throw new Error(`Runtime host ${hostId} was not discovered.`);
    const host = this.hosts.get(hostId) ?? await loadAgentHost(hostDefinition);
    if (!this.hosts.has(hostId)) {
      this.hosts.set(hostId, host);
      this.hostStatus.set(hostId, {
        state: 'running',
        startedAt: new Date().toISOString(),
        ...(host.process?.pid ? { pid: host.process.pid } : {})
      });
    }
    const mode = host.capabilities.supportsSkills ? 'native' : host.capabilities.supportsTools ? 'tools' : 'context';
    return {
      agentId: hostId,
      hostId,
      skill,
      mode,
      instructions: await loadSkillInstructions(skill)
    };
  }

  /** Resolves one portable profile/provider/host/skills binding for session launch. */
  public async createBinding(
    profileId: string,
    hostId: string,
    provider: AgentProviderRef,
    skillNames: string[]
  ): Promise<AgentBinding> {
    const snapshot = await this.list();
    const profile = snapshot.profiles.find(candidate => candidate.profile.id === profileId);
    if (!profile) throw new Error(`Agent profile ${profileId} was not discovered.`);
    if (profile.error) throw new Error(`Agent profile ${profileId} is invalid: ${profile.error}`);
    if (!profile.trusted) throw new Error(`Agent profile ${profileId} is not trusted.`);
    const host = snapshot.runtimeHosts.find(candidate => candidate.manifest.id === hostId);
    if (!host) throw new Error(`Runtime host ${hostId} was not discovered.`);

    const skills: AgentSkillRef[] = await Promise.all(skillNames.map(async name => {
      const skill = snapshot.skills.find(candidate => candidate.metadata.name === name);
      if (!skill) throw new Error(`Skill ${name} was not discovered.`);
      return {
        id: name,
        ...(skill.metadata.version ? { version: skill.metadata.version } : {}),
        instructions: await loadSkillInstructions(skill)
      };
    }));
    const capabilities = snapshot.capabilities[hostId];
    const activations = planSkillActivations(skills, {
      supportsNativeSkills: capabilities?.supportsSkills === true,
      supportsTools: capabilities?.supportsTools === true,
      supportsResume: capabilities?.supportsResume === true
    });
    return {
      profile: profile.profile,
      provider,
      host: toAgentHostManifest(host),
      skills,
      activations
    };
  }

  public async bindingContext(binding: AgentBinding): Promise<string> {
    return buildProfileContext(binding);
  }

  public async dispose(): Promise<void> {
    await Promise.all([...this.hosts.values()].map(host => host.dispose()));
    this.hosts.clear();
    this.hostStatus.clear();
  }

  public getSnapshot(): AgentRuntimeSnapshot { return this.snapshot; }
  public async list(): Promise<AgentRuntimeSnapshot> { return this.snapshot.refreshedAt ? this.snapshot : this.refresh(); }
}
