import { randomUUID } from 'node:crypto';
import {
  PROVIDER_DESCRIPTORS,
  type AgentSessionRecord,
  type AgentTaskDefinition,
  type AiProvider,
  type IssueDetails,
} from '@praxis/core';
import { continueAgentTask, launchAgentTask, prepareAgentLaunch, preparePersistedAgentLaunch } from './agentSessionLauncher';
import { abortActiveTask, getAiSessionManager, hasActiveTask } from './aiInstance';
import { getProjectStore } from './projectStoreInstance';
import { getSettingsBackend } from './settingsBackendInstance';

function recordForSession(sessionId: string): AgentSessionRecord | undefined {
  const manager = getAiSessionManager();
  return manager.getAgentSession(sessionId)
    ?? [...manager.getAllAgentSessions().values()].find(record => record.sessionId === sessionId);
}

function issueKeyForSession(sessionId: string): string {
  const record = recordForSession(sessionId);
  if (!record) throw new Error(`No agent session found for ${sessionId}.`);
  return record.issueKey;
}

export async function createMobileInteractiveSession(input: {
  projectId: string;
  title: string;
  message: string;
  provider?: string;
  model?: string;
}): Promise<AgentSessionRecord> {
  const project = getProjectStore().get(input.projectId);
  if (!project) throw new Error(`Project ${input.projectId} was not found.`);
  const settings = getSettingsBackend().read();
  const requestedProvider = input.provider?.trim();
  const provider = requestedProvider && requestedProvider in PROVIDER_DESCRIPTORS
    ? requestedProvider as AiProvider
    : settings.ai.activeProvider;
  const workingDirectory = project.workspaceFolder?.trim() || settings.ai.workingDirectory.trim() || undefined;
  const toolMode = project.defaultAiToolMode ?? 'full';
  if (toolMode === 'full' && !workingDirectory) {
    throw new Error('The selected project needs a working folder before a full-tools mobile session can start.');
  }

  const issueKey = `SESSION-${randomUUID().slice(0, 8)}`;
  const issue = {
    key: issueKey,
    summary: input.title.trim() || input.message.trim().slice(0, 80),
    issueType: 'Task',
    status: 'New',
    projectKey: project.key,
  } as IssueDetails;
  const taskDefinition: AgentTaskDefinition = {
    kind: 'general',
    sessionMode: 'chat',
    goal: input.message.trim(),
    scope: `Project ${project.name} (${project.id}) and its configured working folder.`,
    definitionOfDone: 'Respond to the user and remain available for follow-up turns.',
  };
  const prepared = await prepareAgentLaunch({ provider });
  await launchAgentTask(prepared, {
    issue,
    taskDefinition,
    provider,
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    workingDirectory,
    toolMode,
  });
  const manager = getAiSessionManager();
  const record = manager.getAgentSession(issueKey);
  if (!record) throw new Error(`Session for ${issueKey} did not start.`);
  manager.updateAgentRuntime(issueKey, { projectId: project.id, workingDirectory, toolMode });
  manager.renameAgentSession(issueKey, issue.summary);
  return manager.getAgentSession(issueKey) ?? record;
}

export async function continueMobileInteractiveSession(sessionId: string, message: string): Promise<AgentSessionRecord> {
  const record = recordForSession(sessionId);
  if (!record) throw new Error(`No agent session found for ${sessionId}.`);
  if (hasActiveTask(record.issueKey)) throw new Error('This session already has an active turn.');
  const provider = record.provider ?? getSettingsBackend().read().ai.activeProvider;
  const prepared = await preparePersistedAgentLaunch(record, provider);
  await continueAgentTask(prepared, {
    issueKey: record.issueKey,
    message,
    model: record.model,
    workingDirectory: record.workingDirectory,
    toolMode: record.toolMode ?? 'full',
  });
  return recordForSession(sessionId)!;
}

export async function cancelMobileInteractiveSession(sessionId: string): Promise<AgentSessionRecord> {
  const issueKey = issueKeyForSession(sessionId);
  if (hasActiveTask(issueKey)) await abortActiveTask(issueKey);
  const manager = getAiSessionManager();
  const record = manager.getAgentSession(issueKey)!;
  if (!['completed', 'failed', 'aborted'].includes(record.state)) manager.updateAgentState(issueKey, 'aborted');
  return manager.getAgentSession(issueKey)!;
}
