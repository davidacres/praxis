import { discoverAgents, type DiscoveryOptions } from './discovery';
import type { DiscoveredAgent } from './manifest';
import { discoverSkills, loadSkillInstructions, type DiscoveredSkill } from './skillRegistry';
import { discoverAgentProfiles, type DiscoveredAgentProfile } from './profileRegistry';
import { bundledAgentDescription, bundledSkill, isBundledAgent } from './bundledAgents';
import {
  MAX_INSTRUCTION_CHARS,
  discoverNativeSources,
  mergeById,
  readNatively,
  type NativeInstructionFile,
  type NativeSourceOptions
} from './nativeSources';
import type { AiProvider } from '../../types';
import { PROVIDER_DESCRIPTORS } from '../providers/registry';
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
  runtimeHosts?: DiscoveredAgent[];
  profiles?: DiscoveredAgentProfile[];
  skills: DiscoveredSkill[];
  capabilities: Record<string, AgentCapabilities>;
  hosts: Record<string, HostRuntimeStatus>;
  refreshedAt: string;
  /** Instruction files other AI tools keep (contents omitted; see `nativeInstructionFiles`). */
  instructions?: Array<Omit<NativeInstructionFile, 'content'>>;
  /** The project folder other tools' files were read from, and whether its files are approved. */
  nativeProject?: { root: string; approved: boolean; itemCount: number };
}

export interface AgentRuntimeManagerOptions extends DiscoveryOptions {
  /** Where to look for other AI tools' agents, skills and instructions; read at every refresh. */
  nativeSources?: () => NativeSourceOptions | undefined | Promise<NativeSourceOptions | undefined>;
  /** The user's "Runs on" choices, agent id → local runtime; read at every refresh. */
  agentRuntimes?: () => Record<string, AiProvider> | undefined;
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

/**
 * Pins (`replaces`): a trusted host that names an existing agent becomes that
 * agent's launch binding — the agent keeps its own instructions and runs on the
 * pin's runtime. The pin is not an agent of its own. With several pins for one
 * agent the first by id wins (the marketplace keeps one installed per agent).
 */
export function resolvePins(hosts: readonly DiscoveredAgent[], profileIds: ReadonlySet<string>): DiscoveredAgent[] {
  const pins = hosts
    .filter(host => host.manifest.replaces && host.trusted && host.errors.length === 0 && profileIds.has(host.manifest.replaces))
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
  if (pins.length === 0) return [...hosts];
  const winners = new Map<string, DiscoveredAgent>();
  for (const pin of pins) if (!winners.has(pin.manifest.replaces!)) winners.set(pin.manifest.replaces!, pin);
  const pinned = (target: string, pin: DiscoveredAgent): DiscoveredAgent => {
    const { replaces: _replaces, ...manifest } = pin.manifest;
    return {
      ...pin,
      manifest: { ...manifest, id: target },
      pinnedBy: { id: pin.manifest.id, name: pin.manifest.name, manifestPath: pin.manifestPath }
    };
  };
  const result = hosts
    .filter(host => !pins.includes(host))
    .map(host => (winners.has(host.manifest.id) ? pinned(host.manifest.id, winners.get(host.manifest.id)!) : host));
  for (const [target, pin] of winners) {
    if (!result.some(host => host.manifest.id === target)) result.push(pinned(target, pin));
  }
  return result;
}

/** "Claude Code (local)" → "Claude Code". */
export function runtimeDisplayName(provider: AiProvider): string {
  return PROVIDER_DESCRIPTORS[provider].label.replace(/\s*\(local\)$/, '').replace(/ CLI$/, '');
}

/**
 * The user's "Runs on" choices: each named agent's launch binding becomes the
 * chosen local runtime (over ACP), whatever the session uses. Wins over an
 * add-on pin; agents that are not in the catalog, and choices that are not
 * local ACP runtimes, are ignored.
 */
export function applyRuntimeChoices(
  hosts: readonly DiscoveredAgent[],
  profiles: readonly DiscoveredAgentProfile[],
  choices: Record<string, AiProvider>
): DiscoveredAgent[] {
  const result = [...hosts];
  for (const [agentId, provider] of Object.entries(choices)) {
    const descriptor = PROVIDER_DESCRIPTORS[provider];
    const profile = profiles.find(entry => entry.profile.id === agentId);
    if (!profile || descriptor?.kind !== 'cli-agent' || descriptor.hostKind !== 'acp' || !descriptor.defaultCommand) continue;
    const index = result.findIndex(host => host.manifest.id === agentId);
    const existing = index >= 0 ? result[index] : undefined;
    const name = runtimeDisplayName(provider);
    const chosen: DiscoveredAgent = {
      manifest: {
        schemaVersion: 1,
        id: agentId,
        name,
        type: 'acp',
        entry: { command: descriptor.defaultCommand, ...(descriptor.defaultArgs ? { args: [...descriptor.defaultArgs] } : {}) }
      },
      manifestPath: existing?.manifestPath ?? profile.profilePath,
      rootPath: existing?.rootPath ?? profile.rootPath,
      scope: existing?.scope ?? profile.scope,
      // The choice picks a runtime, not new instructions: trust stays the agent's.
      trusted: existing?.trusted ?? profile.trusted,
      errors: [],
      pinnedBy: { id: `runtime:${provider}`, name, manifestPath: '', runtime: provider, setting: true }
    };
    if (index >= 0) result[index] = chosen;
    else result.push(chosen);
  }
  return result;
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
  private nativeInstructions: NativeInstructionFile[] = [];
  private readonly skillModes = new Map<string, Map<string, 'native' | 'tools' | 'context'>>();

  public constructor(private readonly options: AgentRuntimeManagerOptions) {}

  public async refresh(): Promise<AgentRuntimeSnapshot> {
    const profileRoots = this.options.profileRoots ?? [
      ...(this.options.userAgentsPath ? [this.options.userAgentsPath] : []),
      ...(this.options.allowProjectAgents && this.options.projectAgentsPath ? [this.options.projectAgentsPath] : [])
    ];
    const [discoveredHosts, profiles, skills] = await Promise.all([
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
    // Built-in agents written before descriptions existed keep their AGENT.md
    // (user edits are preserved), so their list description comes from the bundle.
    const alignedProfiles = profiles.map(entry => {
      const builtIn = isBundledAgent(entry.profile.id);
      const description = entry.profile.description ?? bundledAgentDescription(entry.profile.id);
      return {
        ...entry,
        ...(builtIn ? { builtIn } : {}),
        profile: { ...entry.profile, ...(description ? { description } : {}) }
      };
    });
    // Same for skills installed before titles existed.
    const labelledSkills = skills.map(skill => {
      const bundled = bundledSkill(skill.metadata.name);
      if (!bundled) return skill;
      return { ...skill, builtIn: true, metadata: { ...skill.metadata, title: skill.metadata.title ?? bundled.title } };
    });

    const runtimeHosts = resolvePins(discoveredHosts, new Set(alignedProfiles.map(entry => entry.profile.id)));

    for (const runtimeHost of runtimeHosts) {
      if (alignedProfiles.some(profile => profile.profile.id === runtimeHost.manifest.id)) continue;
      alignedProfiles.push({
        profile: {
          id: runtimeHost.manifest.id,
          name: runtimeHost.manifest.name,
          instructions: `Use the ${runtimeHost.manifest.name} runtime to complete the supplied task.`
        },
        profilePath: runtimeHost.manifestPath,
        rootPath: runtimeHost.rootPath,
        fingerprint: 'legacy-host-profile',
        scope: runtimeHost.scope,
        trusted: runtimeHost.trusted,
        legacy: true
      });
    }
    // Other AI tools' agents and skills join the catalog; one entry per id.
    const nativeOptions = await this.options.nativeSources?.();
    const native = nativeOptions ? await discoverNativeSources(nativeOptions) : undefined;
    this.nativeInstructions = native?.instructions ?? [];
    const mergedProfiles = mergeById([...alignedProfiles, ...(native?.agents ?? [])], entry => entry.profile.id);
    const mergedSkills = mergeById([...labelledSkills, ...(native?.skills ?? [])], skill => skill.metadata.name);

    // An agent from another tool has no host of its own: give it one that
    // runs on whatever runtime the session uses, like the built-in agents.
    let hosts = [...runtimeHosts];
    for (const entry of mergedProfiles) {
      if (!entry.source || hosts.some(host => host.manifest.id === entry.profile.id)) continue;
      hosts.push({
        manifest: { schemaVersion: 1, id: entry.profile.id, name: entry.profile.name, type: 'gateway', entry: 'session' },
        manifestPath: entry.profilePath,
        rootPath: entry.rootPath,
        scope: entry.scope,
        trusted: entry.trusted,
        errors: [],
        followsSessionRuntime: true
      });
    }
    hosts = applyRuntimeChoices(hosts, mergedProfiles, this.options.agentRuntimes?.() ?? {});
    const nativeItems = (native?.agents.length ?? 0) + (native?.skills.length ?? 0) + (native?.instructions.length ?? 0);
    const projectItems = [...(native?.agents ?? []), ...(native?.skills ?? [])].filter(item => item.source?.scope === 'project').length
      + (native?.instructions ?? []).filter(file => file.scope === 'project').length;

    this.snapshot = {
      agents: hosts,
      runtimeHosts: hosts,
      profiles: mergedProfiles,
      skills: mergedSkills,
      capabilities: Object.fromEntries([...this.hosts].map(([id, host]) => [id, host.capabilities])),
      hosts: Object.fromEntries(this.hostStatus),
      refreshedAt: new Date().toISOString(),
      ...(native ? { instructions: native.instructions.map(({ content, ...file }) => ({ ...file, tooLargeForSessions: content.length > MAX_INSTRUCTION_CHARS })) } : {}),
      ...(native?.projectRoot && nativeItems > 0
        ? { nativeProject: { root: native.projectRoot, approved: nativeOptions?.projectApproved === true, itemCount: projectItems } }
        : {})
    };
    return this.snapshot;
  }

  public async start(hostId: string): Promise<AgentRuntimeSnapshot> {
    const listed = await this.list();
    const hostDefinition = (listed.runtimeHosts ?? listed.agents).find(candidate => candidate.manifest.id === hostId);
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
    this.skillModes.delete(hostId);
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
    const hostDefinition = (snapshot.runtimeHosts ?? snapshot.agents).find(candidate => candidate.manifest.id === hostId);
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
    const instructions = await loadSkillInstructions(skill);
    let mode: 'native' | 'tools' | 'context' = host.capabilities.supportsTools ? 'tools' : 'context';
    if (host.capabilities.supportsSkills && host.activateSkill) {
      try {
        if (await host.activateSkill({ name: skillName, path: skill.skillPath, instructions })) mode = 'native';
      } catch {
        mode = host.capabilities.supportsTools ? 'tools' : 'context';
      }
    }
    const modes = this.skillModes.get(hostId) ?? new Map<string, 'native' | 'tools' | 'context'>();
    modes.set(skillName, mode);
    this.skillModes.set(hostId, modes);
    return { agentId: hostId, hostId, skill, mode, instructions };
  }

  /** Resolves one portable profile/provider/host/skills binding for session launch. */
  public async createBinding(
    profileId: string,
    hostId: string,
    provider: AgentProviderRef,
    skillNames: string[]
  ): Promise<AgentBinding> {
    const snapshot = await this.list();
    const profile = (snapshot.profiles ?? []).find(candidate => candidate.profile.id === profileId);
    if (!profile) throw new Error(`Agent profile ${profileId} was not discovered.`);
    if (profile.error) throw new Error(`Agent profile ${profileId} is invalid: ${profile.error}`);
    if (!profile.trusted) throw new Error(`Agent profile ${profileId} is not trusted.`);
    const host = (snapshot.runtimeHosts ?? snapshot.agents).find(candidate => candidate.manifest.id === hostId);
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
    const capabilities = this.hosts.get(hostId)?.capabilities ?? snapshot.capabilities[hostId];
    const planned = planSkillActivations(skills, {
      supportsNativeSkills: false,
      supportsTools: capabilities?.supportsTools === true,
      supportsResume: capabilities?.supportsResume === true
    });
    const confirmed = this.skillModes.get(hostId);
    const activations = planned.map(activation => {
      // A skill from a tool's own folder is loaded by that tool's runtime
      // itself — adding its instructions again would double them.
      const source = snapshot.skills.find(candidate => candidate.metadata.name === activation.skillId)?.source;
      if (readNatively(source, provider.id as AiProvider)) {
        return { ...activation, mode: 'native' as const, reason: 'The runtime loads this skill from its own folder.', instructionsIncluded: false };
      }
      const mode = confirmed?.get(activation.skillId) ?? activation.mode;
      return {
        ...activation,
        mode,
        reason: mode === 'native' ? 'Runtime host confirmed native skill activation.' : activation.reason,
        instructionsIncluded: mode !== 'native'
      };
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
    this.skillModes.clear();
  }

  public getSnapshot(): AgentRuntimeSnapshot { return this.snapshot; }
  /** Instruction files (with contents) found at the last refresh. */
  public nativeInstructionFiles(): readonly NativeInstructionFile[] { return this.nativeInstructions; }
  public async list(): Promise<AgentRuntimeSnapshot> { return this.snapshot.refreshedAt ? this.snapshot : this.refresh(); }
}
