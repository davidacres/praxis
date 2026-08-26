import { discoverAgents, type DiscoveryOptions } from './discovery';
import type { DiscoveredAgent } from './manifest';
import { discoverSkills, loadSkillInstructions, type DiscoveredSkill } from './skillRegistry';
import { loadAgentHost, type AgentCapabilities, type AgentHostHandle } from './hostLoader';
export interface AgentRuntimeSnapshot { agents: DiscoveredAgent[]; skills: DiscoveredSkill[]; capabilities: Record<string, AgentCapabilities>; refreshedAt: string; }
export interface AgentRuntimeManagerOptions extends DiscoveryOptions { skillRoots?: string[]; trustedSkillRoots?: string[]; }
export interface ActivatedSkill { agentId: string; skill: DiscoveredSkill; mode: 'native' | 'context' | 'tools'; instructions: string; }
/** Discovery/registry coordinator. Host adapters can be layered on this snapshot. */
export class AgentRuntimeManager {
  private snapshot: AgentRuntimeSnapshot = { agents: [], skills: [], capabilities: {}, refreshedAt: '' };
  private readonly hosts = new Map<string, AgentHostHandle>();
  public constructor(private readonly options: AgentRuntimeManagerOptions) {}
  public async refresh(): Promise<AgentRuntimeSnapshot> {
    const [agents, skills] = await Promise.all([discoverAgents(this.options), discoverSkills(this.options.skillRoots ?? [], this.options.trustedSkillRoots ?? this.options.skillRoots ?? [])]);
    this.snapshot = { agents, skills, capabilities: Object.fromEntries([...this.hosts].map(([id, host]) => [id, host.capabilities])), refreshedAt: new Date().toISOString() };
    return this.snapshot;
  }
  public async start(agentId: string): Promise<AgentRuntimeSnapshot> {
    const agent = (await this.list()).agents.find(candidate => candidate.manifest.id === agentId);
    if (!agent) throw new Error(`Agent ${agentId} was not discovered.`);
    await this.hosts.get(agentId)?.dispose();
    this.hosts.set(agentId, await loadAgentHost(agent));
    return this.refresh();
  }
  public async activateSkill(agentId: string, skillName: string): Promise<ActivatedSkill> {
    const snapshot = await this.list();
    const skill = snapshot.skills.find(candidate => candidate.metadata.name === skillName);
    if (!skill) throw new Error(`Skill ${skillName} was not discovered.`);
    if (skill.error) throw new Error(`Skill ${skillName} is invalid: ${skill.error}`);
    const agent = snapshot.agents.find(candidate => candidate.manifest.id === agentId);
    if (!agent) throw new Error(`Agent ${agentId} was not discovered.`);
    const host = this.hosts.get(agentId) ?? await loadAgentHost(agent);
    this.hosts.set(agentId, host);
    const mode = host.capabilities.supportsSkills ? 'native' : host.capabilities.supportsTools ? 'tools' : 'context';
    return { agentId, skill, mode, instructions: await loadSkillInstructions(skill) };
  }
  public async dispose(): Promise<void> { await Promise.all([...this.hosts.values()].map(host => host.dispose())); this.hosts.clear(); }
  public getSnapshot(): AgentRuntimeSnapshot { return this.snapshot; }
  public async list(): Promise<AgentRuntimeSnapshot> { return this.snapshot.refreshedAt ? this.snapshot : this.refresh(); }
}
