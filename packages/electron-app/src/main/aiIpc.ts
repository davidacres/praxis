import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import {
  clearProviderApiKey,
  discoverWorkspaceAgentWorkflows,
  PROVIDER_DESCRIPTORS,
  stageIssueAttachments,
  storeProviderApiKey,
  type AgentSessionRecord,
  type AgentTaskDefinition,
  type AgentToolMode,
  type AgentWorkflowReference,
  type AiDelegateInput,
  type AiProvider,
  type AiReviewProgress,
  type IssueDetails,
  type IssueTrackerService,
  type PermissionDecision,
  type VercelAgentStartOptions
} from '@ticket-manager/core';
import {
  abortActiveTask,
  getAcpAgentHost,
  getAiAnalysisStore,
  getAiProviderStatus,
  getAiSessionManager,
  getCopilotAgentHost,
  getVercelAgentService,
  listAiProviderStatuses,
  listApiModelOptions,
  listCliModelOptions,
  resolveAcpStartOptions,
  resolveConnectionOptions,
  resolveCopilotStartOptions,
  respondToActivePermission
} from './aiInstance';
import { getAgentRuntimeManager } from './agentRuntimeInstance';
import { getSecretsStore } from './connectionStoreInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { getServiceForConnection } from './serviceRegistry';
import { isAnalysisConfirmed } from './aiWorkflowIpc';
import { reviewIssueWithRuntime } from './aiReviewRuntime';

/** Builds the default general task for an issue when the caller didn't supply one. */
function buildDefaultTask(
  issue: { summary: string; description?: string },
  overrides?: Partial<AgentTaskDefinition>
): AgentTaskDefinition {
  return {
    kind: 'general',
    goal:
      overrides?.goal ??
      `${issue.summary}${issue.description ? '\n' + issue.description.slice(0, 500) : ''}`,
    scope: overrides?.scope ?? 'This issue and related files',
    definitionOfDone:
      overrides?.definitionOfDone ?? 'All acceptance criteria met, code compiles, tests pass',
    ...(overrides?.workflow ? { workflow: overrides.workflow } : {}),
    ...(overrides?.maxSteps ? { maxSteps: overrides.maxSteps } : {}),
    ...(overrides?.timeoutMs ? { timeoutMs: overrides.timeoutMs } : {})
  };
}

const TRACKER_READ_TOOLS = [
  {
    name: 'tracker_get_ticket',
    description: 'Get the current details of a ticket from the session tracker connection.',
    inputSchema: {
      type: 'object' as const,
      properties: { issueKey: { type: 'string', description: 'Ticket key, for example APP-101' } },
      required: ['issueKey']
    }
  },
  {
    name: 'tracker_list_transitions',
    description: 'List the workflow transitions currently available for a ticket.',
    inputSchema: {
      type: 'object' as const,
      properties: { issueKey: { type: 'string' } },
      required: ['issueKey']
    }
  }
];

const TRACKER_WRITE_TOOLS = [
  {
    name: 'tracker_add_comment',
    description: 'Add a comment to a ticket after user approval.',
    inputSchema: {
      type: 'object' as const,
      properties: { issueKey: { type: 'string' }, body: { type: 'string' } },
      required: ['issueKey', 'body']
    }
  },
  {
    name: 'tracker_update_ticket',
    description: 'Update editable ticket fields after user approval.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        issueKey: { type: 'string' },
        summary: { type: 'string' },
        description: { type: 'string' },
        assignee: { type: ['string', 'null'] },
        priority: { type: 'string' }
      },
      required: ['issueKey']
    }
  },
  {
    name: 'tracker_transition_ticket',
    description: 'Move a ticket through a workflow transition after user approval.',
    inputSchema: {
      type: 'object' as const,
      properties: { issueKey: { type: 'string' }, transitionId: { type: 'string' } },
      required: ['issueKey', 'transitionId']
    }
  }
];

function trackerToolExtension(
  service: IssueTrackerService | undefined,
  toolMode: AgentToolMode
): VercelAgentStartOptions['toolExtension'] | undefined {
  if (!service) return undefined;
  const definitions = toolMode === 'read-only'
    ? TRACKER_READ_TOOLS
    : [...TRACKER_READ_TOOLS, ...TRACKER_WRITE_TOOLS];
  const str = (args: Record<string, unknown>, key: string) =>
    typeof args[key] === 'string' ? (args[key] as string).trim() : '';
  return {
    definitions,
    async execute(name, args, requestPermission) {
      try {
        const issueKey = str(args, 'issueKey');
        if (!issueKey) return { ok: false, content: 'issueKey is required.' };
        if (name === 'tracker_get_ticket') {
          return { ok: true, content: JSON.stringify(await service.getIssue(issueKey), null, 2) };
        }
        if (name === 'tracker_list_transitions') {
          return { ok: true, content: JSON.stringify(await service.getTransitions(issueKey), null, 2) };
        }
        const allowed = await requestPermission({
          kind: 'tracker-write',
          description: `Permission requested: ${name} on ${issueKey}`,
          detail: JSON.stringify(args, null, 2)
        });
        if (allowed === 'deny') return { ok: false, content: `Permission denied for ${name}.` };
        if (name === 'tracker_add_comment') {
          const body = str(args, 'body');
          if (!body) return { ok: false, content: 'body is required.' };
          await service.addComment(issueKey, body);
          return { ok: true, content: `Comment added to ${issueKey}.` };
        }
        if (name === 'tracker_update_ticket') {
          const update = {
            ...(str(args, 'summary') ? { summary: str(args, 'summary') } : {}),
            ...(str(args, 'description') ? { description: str(args, 'description') } : {}),
            ...(args.assignee === null || typeof args.assignee === 'string' ? { assignee: args.assignee as string | null } : {}),
            ...(str(args, 'priority') ? { priority: str(args, 'priority') } : {})
          };
          return { ok: true, content: JSON.stringify(await service.updateIssue(issueKey, update), null, 2) };
        }
        if (name === 'tracker_transition_ticket') {
          const transitionId = str(args, 'transitionId');
          if (!transitionId) return { ok: false, content: 'transitionId is required.' };
          await service.transitionIssue(issueKey, transitionId);
          return { ok: true, content: `Transition ${transitionId} applied to ${issueKey}.` };
        }
        return { ok: false, content: `Unknown tracker tool: ${name}` };
      } catch (error) {
        return { ok: false, content: error instanceof Error ? error.message : String(error) };
      }
    }
  };
}

/**
 * Registers the AI IPC channels: provider setup (`ai:getStatus`, `ai:setApiKey`),
 * session lifecycle (`ai:listSessions`, `ai:delegate`, `ai:abort`), and the
 * `ai:sessionChanged` push channel that streams session record updates to every
 * live window — the desktop equivalent of the extension's EventEmitter wiring.
 */
export function registerAiIpc(): void {
  const sessionManager = getAiSessionManager();
  const agentService = getVercelAgentService();

  ipcMain.handle('ai:getStatus', async () => getAiProviderStatus());

  ipcMain.handle('ai:listProviderStatuses', async () => listAiProviderStatuses());

  ipcMain.handle('ai:listCliModelOptions', async (_event: Electron.IpcMainInvokeEvent, provider: AiProvider) =>
    listCliModelOptions(provider)
  );

  ipcMain.handle(
    'ai:listApiModelOptions',
    async (_event: Electron.IpcMainInvokeEvent, provider: AiProvider, forceRefresh?: boolean) =>
      listApiModelOptions(provider, forceRefresh)
  );

  ipcMain.handle(
    'ai:setProviderApiKey',
    async (_event: Electron.IpcMainInvokeEvent, provider: AiProvider, value: string) => {
      const trimmed = typeof value === 'string' ? value.trim() : '';
      if (trimmed) {
        await storeProviderApiKey(getSecretsStore(), provider, trimmed);
      } else {
        await clearProviderApiKey(getSecretsStore(), provider);
      }
      const statuses = await listAiProviderStatuses();
      return statuses.find(s => s.provider === provider) ?? (await getAiProviderStatus());
    }
  );

  // Back-compat: applies to the currently active provider.
  ipcMain.handle('ai:setApiKey', async (_event: Electron.IpcMainInvokeEvent, value: string) => {
    const settings = getSettingsBackend().read();
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) {
      await storeProviderApiKey(getSecretsStore(), settings.ai.activeProvider, trimmed);
    } else {
      await clearProviderApiKey(getSecretsStore(), settings.ai.activeProvider);
    }
    return getAiProviderStatus();
  });

  ipcMain.handle('ai:listSessions', async () =>
    [...sessionManager.getAllAgentSessions().values()].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt)
    )
  );

  ipcMain.handle(
    'ai:renameSession',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, title: string) =>
      sessionManager.renameAgentSession(issueKey, title)
  );

  ipcMain.handle('ai:deleteSession', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) => {
    if (!sessionManager.getAgentSession(issueKey)) {
      throw new Error(`No agent session found for ${issueKey}.`);
    }
    await abortActiveTask(issueKey);
    sessionManager.removeAgentSession(issueKey);
    sessionManager.removeSession(issueKey);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ai:sessionDeleted', issueKey);
      }
    }
  });

  ipcMain.handle(
    'ai:delegate',
    async (_event: Electron.IpcMainInvokeEvent, input: AiDelegateInput) => {
      const settings = getSettingsBackend().read();
      const isAnalysisSession = input.purpose === 'analysis';
      if (isAnalysisSession && !input.issueKey) {
        throw new Error('Ticket analysis requires an issue key.');
      }
      const analysisPrompt = settings.ai.analysisPrompt.trim();
      if (isAnalysisSession && !analysisPrompt) {
        throw new Error('Set an analysis system prompt under Settings → AI Provider first.');
      }
      const provider = input.provider ?? settings.ai.activeProvider;
      const descriptor = PROVIDER_DESCRIPTORS[provider];

      // Only `kind: 'api'` providers need an API key up front — CLI-hosted
      // providers (Claude Code, Codex) authenticate themselves.
      const gateway = descriptor.kind === 'api' ? await resolveConnectionOptions(provider) : undefined;
      if (descriptor.kind === 'api' && !gateway?.apiKey) {
        throw new Error(`No ${descriptor.label} API key configured. Add one under Settings → AI Provider.`);
      }

      let issue: IssueDetails;
      let issueService: Awaited<ReturnType<typeof getServiceForConnection>> | undefined;
      if (input.issueKey) {
        issueService = await getServiceForConnection(input.connectionId);
        issue = await issueService.getIssue(input.issueKey);
      } else {
        // Free-form session from the New Session composer: no tracker issue, so
        // synthesize a minimal one with a unique key the session is stored under.
        const goal = (input.goal ?? input.task?.goal ?? '').trim();
        if (!goal) {
          throw new Error('Delegate needs either an issue key or a goal.');
        }
        issue = {
          key: `SESSION-${randomUUID().slice(0, 8)}`,
          summary: goal,
          issueType: 'Task',
          status: 'New',
          projectKey: 'SESSION'
        } as IssueDetails;
      }

      // Analysis gate: when enabled, an issue-bound delegation requires a
      // confirmed analysis first (mirrors the extension's assignIssueToAi gate).
      if (input.issueKey && settings.ai.analysisGateEnabled && !isAnalysisSession) {
        if (!isAnalysisConfirmed(getAiAnalysisStore(), input.issueKey)) {
          throw new Error(
            `Analysis for ${input.issueKey} must be confirmed before delegating (the analysis gate is enabled in Settings → AI Provider).`
          );
        }
      }

      const taskDefinition: AgentTaskDefinition = isAnalysisSession
        ? {
            kind: 'analysis',
            goal: [
              analysisPrompt,
              `Analyze ${issue.key} — ${issue.summary}.`,
              'This is the first, read-only turn of the ticket session. Do not implement anything yet.'
            ].join('\n\n'),
            scope: 'Read-only analysis of this ticket and the relevant repository code, tests, dependencies and risks.',
            definitionOfDone:
              'A clear analysis and ordered implementation plan is posted in this session for the user to review.',
            nonGoals: [
              'Do not edit files or change external state during this first turn.',
              'Do not begin implementation until the user confirms the analysis in this session.'
            ],
            completionContract: 'Stop after presenting the analysis and wait for confirmation in this same conversation.'
          }
        : buildDefaultTask(issue, input.task);
      // Workflow pack: an explicit task.workflow wins; otherwise apply the
      // issue's assigned pack so delegation and delivery behave the same.
      if (!taskDefinition.workflow && input.issueKey) {
        const assignment = sessionManager.getIssueWorkflowAssignment(input.issueKey);
        if (assignment?.workflow) {
          taskDefinition.workflow = assignment.workflow;
        }
      }
      // Match the extension's ticket-aware session start: stage every useful
      // issue attachment and add the generated manifest to the task contract
      // before the shared system prompt is built.
      // Demo issues deliberately expose illustrative attachment metadata but
      // have no downloadable bytes, so only real tracker services are staged.
      if (input.issueKey && issueService && issueService.mode !== 'demo') {
        const attachments = await stageIssueAttachments({
          issue,
          backendService: issueService,
          logger: { appendLine: message => console.log(`[ai] ${message}`) }
        });
        if (attachments.length > 0) {
          taskDefinition.attachments = attachments;
        }
      }
      const workingDirectory =
        input.workingDirectory?.trim() || settings.ai.workingDirectory.trim() || undefined;
      const toolMode = isAnalysisSession ? 'read-only' : (input.toolMode ?? 'full');

      // Runtime skills are activated only when explicitly requested. Their full
      // instructions are injected after metadata discovery, preserving progressive
      // disclosure and the existing provider permission model.
      if (input.agentId && input.skillNames?.length) {
        const runtime = getAgentRuntimeManager();
        const activations = await Promise.all(input.skillNames.map(name => runtime.activateSkill(input.agentId!, name)));
        taskDefinition.goal += `\n\nActivated runtime skills:\n${activations.map(item => `## ${item.skill.metadata.name}\n${item.instructions}`).join('\n\n')}`;
      }

      if (descriptor.kind === 'cli-agent' && descriptor.hostKind === 'copilot-sdk') {
        const { runtimePath, model } = resolveCopilotStartOptions(provider);
        await getCopilotAgentHost().startTask(issue, taskDefinition, provider, {
          runtimePath,
          model: input.model || model,
          workingDirectory,
          toolMode
        });
      } else if (descriptor.kind === 'cli-agent') {
        const { command, args } = resolveAcpStartOptions(provider);
        await getAcpAgentHost().startTask(issue, taskDefinition, provider, {
          command,
          args,
          workingDirectory,
          model: input.model,
          toolMode
        });
      } else {
        await agentService.startTask(issue, taskDefinition, {
          apiKey: gateway!.apiKey,
          gatewayUrl: gateway!.gatewayUrl,
          workingDirectory,
          model: input.model || gateway!.model,
          provider,
          toolMode,
          toolExtension: trackerToolExtension(issueService, toolMode)
        });
      }
      const record = sessionManager.getAgentSession(issue.key);
      if (!record) {
        throw new Error(`Session for ${issue.key} did not start.`);
      }
      if (input.connectionId) {
        sessionManager.updateAgentRuntime(issue.key, { connectionId: input.connectionId });
      }
      return record;
    }
  );

  ipcMain.handle('ai:abort', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) => {
    await abortActiveTask(issueKey);
  });

  ipcMain.handle(
    'ai:continueSession',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, message: string) => {
      const followUp = message.trim();
      if (!followUp) {
        throw new Error('Enter a follow-up message.');
      }
      const record = sessionManager.getAgentSession(issueKey);
      if (!record) {
        throw new Error(`No agent session found for ${issueKey}.`);
      }
      const provider = record.provider ?? getSettingsBackend().read().ai.activeProvider;
      const descriptor = PROVIDER_DESCRIPTORS[provider];
      const settings = getSettingsBackend().read();
      const workingDirectory = record.workingDirectory?.trim() || settings.ai.workingDirectory.trim() || undefined;
      const toolMode = record.toolMode ?? 'full';

      if (descriptor.kind === 'cli-agent' && descriptor.hostKind === 'copilot-sdk') {
        const copilotOptions = resolveCopilotStartOptions(provider);
        await getCopilotAgentHost().continueTask(issueKey, followUp, {
          ...copilotOptions,
          model: record.model || copilotOptions.model,
          workingDirectory,
          toolMode
        });
        return;
      }
      if (descriptor.kind === 'cli-agent') {
        await getAcpAgentHost().continueTask(issueKey, followUp, {
          ...resolveAcpStartOptions(provider),
          model: record.model,
          workingDirectory,
          toolMode
        });
        return;
      }

      const connection = await resolveConnectionOptions(provider);
      if (!connection.apiKey) {
        throw new Error(`No ${descriptor.label} API key configured. Add one under Settings → AI Provider.`);
      }
      const trackerService = record.issueKey.startsWith('SESSION-')
        ? undefined
        : await getServiceForConnection(record.connectionId).catch(() => undefined);
      await agentService.resumeTask(issueKey, {
        provider,
        apiKey: connection.apiKey,
        gatewayUrl: connection.gatewayUrl,
        model: record.model || connection.model,
        workingDirectory,
        toolMode,
        toolExtension: trackerToolExtension(trackerService, toolMode)
      }, followUp);
    }
  );

  ipcMain.handle(
    'ai:respondToPermission',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, decision: PermissionDecision) => {
      respondToActivePermission(issueKey, decision);
    }
  );

  // ── Workflow packs ────────────────────────────────────────────────────────

  ipcMain.handle('ai:listWorkflowPacks', async () => {
    const settings = getSettingsBackend().read();
    return discoverWorkspaceAgentWorkflows(settings.ai.workingDirectory.trim() || undefined);
  });

  ipcMain.handle('ai:getWorkflowAssignment', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) =>
    sessionManager.getIssueWorkflowAssignment(issueKey)
  );

  ipcMain.handle(
    'ai:setWorkflowAssignment',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      workflow: AgentWorkflowReference | null
    ) => {
      if (workflow) {
        sessionManager.setIssueWorkflowAssignment(issueKey, workflow, { source: 'manual' });
      } else {
        sessionManager.removeIssueWorkflowAssignment(issueKey);
      }
    }
  );

  // ── Ticket review ─────────────────────────────────────────────────────────

  const reviewControllers = new Map<string, AbortController>();
  const sendReviewProgress = (progress: AiReviewProgress): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ai:reviewProgress', progress);
      }
    }
  };

  ipcMain.handle(
    'ai:reviewIssue',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      connectionId?: string,
      requestedProvider?: AiProvider,
      requestedModel?: string
    ) => {
      const issue = await (await getServiceForConnection(connectionId)).getIssue(issueKey);
      const settings = getSettingsBackend().read();
      const provider = requestedProvider ?? settings.ai.activeProvider;

      reviewControllers.get(issueKey)?.abort();
      const controller = new AbortController();
      reviewControllers.set(issueKey, controller);
      sendReviewProgress({ issueKey, content: '', done: false });
      try {
        const markdown = await reviewIssueWithRuntime(issue, {
          provider,
          model: requestedModel,
          signal: controller.signal,
          onUpdate: content => sendReviewProgress({ issueKey, content, done: false })
        });
        sendReviewProgress({ issueKey, content: markdown, done: true });
        return markdown;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendReviewProgress({ issueKey, content: '', done: true, error: message });
        throw error;
      } finally {
        reviewControllers.delete(issueKey);
      }
    }
  );

  ipcMain.handle('ai:cancelReview', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) => {
    reviewControllers.get(issueKey)?.abort();
  });

  // ── Local peer review ─────────────────────────────────────────────────────

  ipcMain.handle(
    'ai:localPeerReview',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      connectionId?: string,
      requestedProvider?: AiProvider,
      requestedModel?: string
    ) => {
      const issue = await (await getServiceForConnection(connectionId)).getIssue(issueKey);
      const settings = getSettingsBackend().read();
      const provider = requestedProvider ?? settings.ai.activeProvider;
      const runtime = { provider, model: requestedModel };
      const codeReview = await reviewIssueWithRuntime(issue, {
        ...runtime,
        systemPrompt: 'You are a senior software engineer. Review the implementation for correctness, maintainability, architecture, tests, and performance. Rate findings by severity.'
      });
      const securityReview = await reviewIssueWithRuntime(issue, {
        ...runtime,
        systemPrompt: 'You are a security engineer. Review for OWASP risks, authorization issues, data exposure, input validation, dependency concerns, and secrets handling. Rate findings by severity.'
      });
      const summary = await reviewIssueWithRuntime(
        {
          ...issue,
          description: `${issue.description ?? ''}\n\nCode review:\n${codeReview}\n\nSecurity review:\n${securityReview}`
        },
        {
          ...runtime,
          systemPrompt: 'You are a technical lead. Summarize the supplied code and security reviews with an overall Ready, Needs Changes, or Needs Major Rework verdict and concise next steps.'
        }
      );
      return { codeReview, securityReview, summary };
    }
  );

  sessionManager.onDidChangeAgentSession((record: AgentSessionRecord) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) {
        continue;
      }
      win.webContents.send('ai:sessionChanged', record);
    }
  });
}
