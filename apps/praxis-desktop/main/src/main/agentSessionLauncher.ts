import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  PROVIDER_DESCRIPTORS,
  type AgentBinding,
  type AgentTaskDefinition,
  type AgentToolMode,
  type AgentRuntimeLaunch,
  type AiProvider,
  type IssueDetails,
  type AcpAgentStartOptions,
  type VercelAgentStartOptions,
  type WireImageAttachment
} from '@praxis/core';
import { getAgentRuntimeManager } from './agentRuntimeInstance';
import {
  getAcpAgentHost,
  getAiSessionManager,
  getVercelAgentService,
  resolveAcpStartOptions,
  resolveConnectionOptions
} from './aiInstance';
import { effectiveRuntime, sessionInstructionsFor, sessionWorkingStyle } from './nativeSourcesInstance';

export type AgentHostAdapterState = 'acp' | 'gateway' | 'unsupported' | 'scaffold';

export interface AgentHostLaunchPlan {
  state: AgentHostAdapterState;
  hostId?: string;
  command?: string;
  args?: string[];
  reason?: string;
}

export interface PreparedAgentLaunch {
  provider: AiProvider;
  plan: AgentHostLaunchPlan;
  binding?: AgentBinding;
  skillActivations: Array<{ skillId: string; mode: 'native' | 'tools' | 'context'; version?: string }>;
}

export interface AgentTaskLaunchInput {
  issue: IssueDetails;
  taskDefinition: AgentTaskDefinition;
  provider: AiProvider;
  model?: string;
  workingDirectory?: string;
  toolMode: AgentToolMode;
  /** Allow the agent's own tool-permission requests without asking (still bounded by `toolMode`). */
  autoApprovePermissions?: boolean;
  mcpServers?: AcpAgentStartOptions['mcpServers'];
  toolExtension?: VercelAgentStartOptions['toolExtension'];
}

export interface AgentTaskContinueInput {
  issueKey: string;
  message: string;
  /** Images pasted/dropped into the composer, forwarded to the agent with the message. */
  images?: WireImageAttachment[];
  model?: string;
  workingDirectory?: string;
  toolMode: AgentToolMode;
  internalConversationTurn?: boolean;
  conversationContext?: string;
  mcpServers?: AcpAgentStartOptions['mcpServers'];
  toolExtension?: VercelAgentStartOptions['toolExtension'];
}

function entryCommand(entry: string | { command?: string; args?: string[] }, rootPath: string): { command: string; args: string[] } {
  const rawCommand = typeof entry === 'string' ? entry : entry.command;
  if (!rawCommand?.trim()) throw new Error('The selected agent host does not declare an executable entry point.');
  const command = rawCommand.trim();
  // A manifest may use a bare executable name or a file relative to its own
  // catalog folder. Resolve the latter against the host folder, never against
  // the app cwd (which was the old generic-process behaviour).
  const pathLike = path.isAbsolute(command) || command.includes('/') || command.includes('\\') || command.endsWith('.js');
  return {
    command: pathLike ? path.resolve(rootPath, command) : command,
    args: typeof entry === 'string' ? [] : (entry.args ?? []).map(arg => {
      const argumentPathLike = path.isAbsolute(arg) || arg.startsWith('./') || arg.startsWith('.\\') || arg.endsWith('.js');
      return argumentPathLike && !path.isAbsolute(arg) ? path.resolve(rootPath, arg) : arg;
    })
  };
}

async function isScaffoldHost(rootPath: string): Promise<boolean> {
  try {
    const entry = await readFile(path.join(rootPath, 'index.js'), 'utf8');
    return entry.includes('SCAFFOLD') && entry.includes('scaffold not implemented');
  } catch {
    return false;
  }
}

export function isBundledAgentHost(hostId: string): boolean {
  return hostId.startsWith('praxis-') || hostId === 'csharp-dotnet-code-reviewer';
}

/** Compiles a discovered manifest into an explicit, supported session adapter. */
function acpProviderForCommand(command: string): AiProvider | undefined {
  return (Object.keys(PROVIDER_DESCRIPTORS) as AiProvider[]).find(id => {
    const descriptor = PROVIDER_DESCRIPTORS[id];
    return descriptor.kind === 'cli-agent' && descriptor.hostKind === 'acp' && descriptor.defaultCommand === path.basename(command);
  });
}

export async function compileAgentHostLaunch(
  host: { manifest: { id: string; type: string; entry: string | { command?: string; args?: string[] }; }; rootPath: string; followsSessionRuntime?: boolean; pinnedBy?: unknown },
  provider: AiProvider
): Promise<AgentHostLaunchPlan> {
  // Built-in agents, agents found in other AI tools' folders and copies of
  // them (`entry: "session"`) all run on the session's own runtime — unless a
  // pin (e.g. the marketplace "Claude Implementer") runs the built-in on its own.
  if ((isBundledAgentHost(host.manifest.id) && !host.pinnedBy) || host.followsSessionRuntime || host.manifest.entry === 'session') {
    if (PROVIDER_DESCRIPTORS[provider].kind === 'api') {
      return { state: 'gateway', hostId: host.manifest.id };
    }
    return { state: 'acp', hostId: host.manifest.id, ...resolveAcpStartOptions(provider) };
  }

  if (host.manifest.type === 'acp') {
    if (await isScaffoldHost(host.rootPath)) {
      return {
        state: 'scaffold',
        hostId: host.manifest.id,
        reason: `Agent host "${host.manifest.id}" is a scaffold and has no working protocol adapter.`
      };
    }
    const command = entryCommand(host.manifest.entry, host.rootPath);
    // A pin names a runtime Praxis already configures (`claude-agent-acp`):
    // launch it the way that runtime's sessions do, honouring its CLI path.
    const configured = host.pinnedBy ? acpProviderForCommand(command.command) : undefined;
    return { state: 'acp', hostId: host.manifest.id, ...(configured ? resolveAcpStartOptions(configured) : command) };
  }

  // Gateway hosts intentionally use the configured provider gateway. This is
  // an explicit adapter, not a fallback: a gateway manifest opts into the
  // provider-backed transport and must name a compatible API provider.
  if (host.manifest.type === 'gateway') {
    if (PROVIDER_DESCRIPTORS[provider].kind !== 'api') {
      return {
        state: 'unsupported',
        hostId: host.manifest.id,
        reason: `Gateway host "${host.manifest.id}" requires an API provider; "${PROVIDER_DESCRIPTORS[provider].label}" is CLI-hosted.`
      };
    }
    return { state: 'gateway', hostId: host.manifest.id };
  }

  return {
    state: 'unsupported',
    hostId: host.manifest.id,
    reason: `Agent host "${host.manifest.id}" declares unsupported transport "${host.manifest.type}".`
  };
}

/** Resolves and validates one Agent Hub binding immediately before launch. */
export async function prepareAgentLaunch(input: {
  profileId?: string;
  hostId?: string;
  provider: AiProvider;
  skillNames?: string[];
}): Promise<PreparedAgentLaunch> {
  const profileId = input.profileId?.trim() || undefined;
  const hostId = input.hostId?.trim() || undefined;
  if (!!profileId !== !!hostId) {
    throw new Error('A session binding requires both an agent profile and runtime host.');
  }

  if (!profileId || !hostId) {
    return {
      provider: input.provider,
      plan: PROVIDER_DESCRIPTORS[input.provider].kind === 'cli-agent'
        ? { state: 'acp', ...resolveAcpStartOptions(input.provider) }
        : { state: 'gateway' },
      skillActivations: []
    };
  }

  const runtime = getAgentRuntimeManager();
  const snapshot = await runtime.list();
  const host = (snapshot.runtimeHosts ?? snapshot.agents).find(candidate => candidate.manifest.id === hostId);
  if (!host) throw new Error(`Runtime host "${hostId}" was not discovered.`);
  if (!host.trusted) throw new Error(`Runtime host "${hostId}" is not trusted.`);
  if (host.errors.length > 0) {
    throw new Error(`Runtime host "${hostId}" has manifest errors: ${host.errors.map(error => `${error.path}: ${error.message}`).join('; ')}`);
  }

  const skillNames = input.skillNames ?? [];
  const binding = await runtime.createBinding(profileId, hostId, { id: input.provider }, skillNames);
  const plan = await compileAgentHostLaunch(host, input.provider);
  if (plan.state === 'unsupported' || plan.state === 'scaffold') throw new Error(plan.reason);
  const skillActivations = binding.activations.map(activation => {
    const version = binding.skills.find(skill => skill.id === activation.skillId)?.version;
    return { skillId: activation.skillId, mode: activation.mode, ...(version ? { version } : {}) };
  });
  return { provider: input.provider, plan, binding, skillActivations };
}

/** Starts a task using the adapter selected by prepareAgentLaunch. */
export async function launchAgentTask(prepared: PreparedAgentLaunch, input: AgentTaskLaunchInput): Promise<void> {
  // Instruction files other AI tools keep in the project, minus the ones this
  // runtime already reads itself.
  const projectInstructions = await sessionInstructionsFor(effectiveRuntime(input.provider, prepared.plan), input.workingDirectory);
  const workingStyle = sessionWorkingStyle();
  input = {
    ...input,
    taskDefinition: {
      ...input.taskDefinition,
      ...(projectInstructions ? { projectInstructions } : {}),
      ...(workingStyle ? { workingStyle } : {})
    }
  };
  if (prepared.plan.state === 'acp') {
    await getAcpAgentHost().startTask(input.issue, input.taskDefinition, input.provider, {
      command: prepared.plan.command!,
      args: prepared.plan.args,
      workingDirectory: input.workingDirectory,
      model: input.model,
      toolMode: input.toolMode,
      ...(input.autoApprovePermissions ? { autoApprovePermissions: true } : {}),
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {})
    });
    recordRuntimeLaunch(input.issue.key, prepared, 'acp');
    return;
  }
  if (prepared.plan.state !== 'gateway') {
    throw new Error(prepared.plan.reason ?? 'The selected agent host cannot be launched.');
  }
  const connection = await resolveConnectionOptions(input.provider);
  if (!connection.apiKey) {
    throw new Error(`No ${PROVIDER_DESCRIPTORS[input.provider].label} API key configured for this session.`);
  }
  await getVercelAgentService().startTask(input.issue, input.taskDefinition, {
    apiKey: connection.apiKey,
    gatewayUrl: connection.gatewayUrl,
    workingDirectory: input.workingDirectory,
    model: input.model || connection.model,
    provider: input.provider,
    toolMode: input.toolMode,
    ...(input.autoApprovePermissions ? { autoApprovePermissions: true } : {}),
    ...(input.toolExtension ? { toolExtension: input.toolExtension } : {})
  });
  recordRuntimeLaunch(input.issue.key, prepared, 'gateway');
}

function recordRuntimeLaunch(issueKey: string, prepared: PreparedAgentLaunch, transport: 'acp' | 'gateway'): void {
  getAiSessionManager().updateAgentRuntime(issueKey, {
    runtimeLaunch: {
      adapter: prepared.binding ? transport : transport === 'acp' ? 'legacy-acp' : 'legacy-gateway',
      transport,
      ...(prepared.plan.hostId ? { hostId: prepared.plan.hostId } : {}),
      ...(prepared.plan.command ? { command: prepared.plan.command } : {})
    } satisfies AgentRuntimeLaunch
  });
}

/** Continues a session through the same compiled adapter used for its first turn. */
export async function continueAgentTask(
  prepared: PreparedAgentLaunch,
  input: AgentTaskContinueInput
): Promise<void> {
  const provider = prepared.provider;
  // Recomputed each turn: a handover can move the session to a runtime that
  // reads a different set of instruction files.
  getAiSessionManager().setProjectInstructions(
    input.issueKey,
    await sessionInstructionsFor(effectiveRuntime(provider, prepared.plan), input.workingDirectory)
  );
  getAiSessionManager().setWorkingStyle(input.issueKey, sessionWorkingStyle());
  if (prepared.plan.state === 'acp') {
    await getAcpAgentHost().continueTask(input.issueKey, input.message, {
      command: prepared.plan.command!,
      args: prepared.plan.args,
      model: input.model,
      workingDirectory: input.workingDirectory,
      toolMode: input.toolMode,
      internalConversationTurn: input.internalConversationTurn,
      conversationContext: input.conversationContext,
      ...(input.images?.length ? { images: input.images } : {}),
      ...(input.mcpServers ? { mcpServers: input.mcpServers } : {})
    });
    recordRuntimeLaunch(input.issueKey, prepared, 'acp');
    return;
  }
  if (prepared.plan.state !== 'gateway') {
    throw new Error(prepared.plan.reason ?? 'The selected agent host cannot be continued.');
  }
  const connection = await resolveConnectionOptions(provider);
  if (!connection.apiKey) {
    throw new Error(`No ${PROVIDER_DESCRIPTORS[provider].label} API key configured for this session.`);
  }
  await getVercelAgentService().resumeTask(input.issueKey, {
    provider,
    apiKey: connection.apiKey,
    gatewayUrl: connection.gatewayUrl,
    model: input.model || connection.model,
    workingDirectory: input.workingDirectory,
    toolMode: input.toolMode,
    internalConversationTurn: input.internalConversationTurn,
    conversationContext: input.conversationContext,
    ...(input.toolExtension ? { toolExtension: input.toolExtension } : {})
  }, input.message, input.images);
  recordRuntimeLaunch(input.issueKey, prepared, 'gateway');
}

/** Recompiles a persisted Agent Hub binding for a follow-up/recovery launch. */
export async function preparePersistedAgentLaunch(record: {
  profileId?: string;
  hostId?: string;
  provider?: AiProvider;
  activeSkills?: string[];
}, fallbackProvider: AiProvider): Promise<PreparedAgentLaunch> {
  return prepareAgentLaunch({
    profileId: record.profileId,
    hostId: record.hostId,
    provider: record.provider ?? fallbackProvider,
    skillNames: record.activeSkills
  });
}
