import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentEntry, DiscoveredAgent } from './manifest';

export interface AgentCapabilities {
  supportsSkills: boolean;
  supportsTools: boolean;
  supportsMemory: boolean;
  supportsResume: boolean;
  supportsStreaming: boolean;
  model?: string;
  version?: string;
}

export interface AgentHostHandle {
  agentId: string;
  capabilities: AgentCapabilities;
  process?: ChildProcess;
  dispose(): Promise<void>;
}

const emptyCapabilities: AgentCapabilities = {
  supportsSkills: false,
  supportsTools: false,
  supportsMemory: false,
  supportsResume: false,
  supportsStreaming: false
};

function normalizeCapabilities(value: unknown): AgentCapabilities {
  const candidate = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    supportsSkills: candidate.supportsSkills === true,
    supportsTools: candidate.supportsTools === true,
    supportsMemory: candidate.supportsMemory === true,
    supportsResume: candidate.supportsResume === true,
    supportsStreaming: candidate.supportsStreaming === true,
    ...(typeof candidate.model === 'string' ? { model: candidate.model } : {}),
    ...(typeof candidate.version === 'string' ? { version: candidate.version } : {})
  };
}

async function httpCapabilities(url: string, timeoutMs: number): Promise<AgentCapabilities> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL('/capabilities', url), { signal: controller.signal });
    if (!response.ok) throw new Error(`Capability handshake returned HTTP ${response.status}.`);
    return normalizeCapabilities(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

function commandEntry(entry: string | AgentEntry): { command: string; args: string[] } {
  if (typeof entry === 'string') return { command: entry, args: [] };
  if (!entry.command) throw new Error('A subprocess host requires entry.command.');
  return { command: entry.command, args: entry.args ?? [] };
}

/** Starts only trusted manifests and never invokes a shell. */
export async function loadAgentHost(agent: DiscoveredAgent, timeoutMs = 5000): Promise<AgentHostHandle> {
  if (!agent.trusted || agent.errors.length > 0) throw new Error(`Agent ${agent.manifest.id} is not trusted or has manifest errors.`);
  const entry = agent.manifest.entry;
  if (agent.manifest.type === 'http') {
    if (typeof entry !== 'object' || !entry.url) throw new Error('HTTP agent requires entry.url.');
    return { agentId: agent.manifest.id, capabilities: await httpCapabilities(entry.url, timeoutMs), dispose: async () => {} };
  }
  const { command, args } = commandEntry(entry);
  const child = spawn(command, args, { cwd: agent.rootPath, shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { PATH: process.env.PATH ?? '' } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('spawn', () => { clearTimeout(timer); resolve(); });
  });
  return {
    agentId: agent.manifest.id,
    // ACP/SDK adapters will replace this generic process handle with their native handshake.
    capabilities: { ...emptyCapabilities, ...(agent.manifest.type === 'gateway' ? { supportsStreaming: true } : {}) },
    process: child,
    dispose: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise<void>(resolve => { child.once('close', () => resolve()); setTimeout(resolve, 1000); });
    }
  };
}
