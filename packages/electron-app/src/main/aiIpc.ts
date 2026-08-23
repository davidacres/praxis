import { randomUUID } from 'node:crypto';
import { BrowserWindow, ipcMain } from 'electron';
import {
  clearVercelApiKey,
  discoverWorkspaceAgentWorkflows,
  reviewTicketWithVercelGateway,
  runLocalPeerReview,
  storeVercelApiKey,
  type AgentSessionRecord,
  type AgentTaskDefinition,
  type AgentWorkflowReference,
  type AiDelegateInput,
  type AiReviewProgress,
  type IssueDetails
} from '@ticket-manager/core';
import {
  getAiAnalysisStore,
  getAiProviderStatus,
  getAiSessionManager,
  getVercelAgentService,
  resolveGatewayOptions
} from './aiInstance';
import { getSecretsStore } from './connectionStoreInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { getServiceForConnection } from './serviceRegistry';
import { isAnalysisConfirmed } from './aiWorkflowIpc';

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

  ipcMain.handle('ai:setApiKey', async (_event: Electron.IpcMainInvokeEvent, value: string) => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed) {
      await storeVercelApiKey(getSecretsStore(), trimmed);
    } else {
      await clearVercelApiKey(getSecretsStore());
    }
    return getAiProviderStatus();
  });

  ipcMain.handle('ai:listSessions', async () =>
    [...sessionManager.getAllAgentSessions().values()].sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt)
    )
  );

  ipcMain.handle(
    'ai:delegate',
    async (_event: Electron.IpcMainInvokeEvent, input: AiDelegateInput) => {
      const gateway = await resolveGatewayOptions();
      if (!gateway.apiKey) {
        throw new Error(
          'No Vercel AI Gateway API key configured. Add one under Settings → AI Provider.'
        );
      }

      let issue: IssueDetails;
      if (input.issueKey) {
        issue = await (await getServiceForConnection(input.connectionId)).getIssue(
          input.issueKey
        );
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

      const settings = getSettingsBackend().read();

      // Analysis gate: when enabled, an issue-bound delegation requires a
      // confirmed analysis first (mirrors the extension's assignIssueToAi gate).
      if (input.issueKey && settings.ai.analysisGateEnabled) {
        if (!isAnalysisConfirmed(getAiAnalysisStore(), input.issueKey)) {
          throw new Error(
            `Analysis for ${input.issueKey} must be confirmed before delegating (the analysis gate is enabled in Settings → AI Provider).`
          );
        }
      }

      const taskDefinition = buildDefaultTask(issue, input.task);
      // Workflow pack: an explicit task.workflow wins; otherwise apply the
      // issue's assigned pack so delegation and delivery behave the same.
      if (!taskDefinition.workflow && input.issueKey) {
        const assignment = sessionManager.getIssueWorkflowAssignment(input.issueKey);
        if (assignment?.workflow) {
          taskDefinition.workflow = assignment.workflow;
        }
      }
      const workingDirectory =
        input.workingDirectory?.trim() || settings.ai.workingDirectory.trim() || undefined;
      await agentService.startTask(issue, taskDefinition, {
        apiKey: gateway.apiKey,
        gatewayUrl: gateway.gatewayUrl,
        workingDirectory,
        model: gateway.model
      });
      const record = sessionManager.getAgentSession(issue.key);
      if (!record) {
        throw new Error(`Session for ${issue.key} did not start.`);
      }
      return record;
    }
  );

  ipcMain.handle('ai:abort', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) => {
    await agentService.abortTask(issueKey);
  });

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
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, connectionId?: string) => {
      const gateway = await resolveGatewayOptions();
      if (!gateway.apiKey) {
        throw new Error(
          'No Vercel AI Gateway API key configured. Add one under Settings → AI Provider.'
        );
      }
      const issue = await (await getServiceForConnection(connectionId)).getIssue(issueKey);
      const settings = getSettingsBackend().read();

      reviewControllers.get(issueKey)?.abort();
      const controller = new AbortController();
      reviewControllers.set(issueKey, controller);
      sendReviewProgress({ issueKey, content: '', done: false });
      try {
        const markdown = await reviewTicketWithVercelGateway(
          issue,
          gateway.apiKey,
          settings.ai.agentName.trim() || 'AI Agent',
          {
            gatewayUrl: gateway.gatewayUrl,
            model: gateway.model,
            signal: controller.signal,
            onUpdate: content => sendReviewProgress({ issueKey, content, done: false })
          }
        );
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
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, connectionId?: string) => {
      const gateway = await resolveGatewayOptions();
      if (!gateway.apiKey) {
        throw new Error(
          'No Vercel AI Gateway API key configured. Add one under Settings → AI Provider.'
        );
      }
      const issue = await (await getServiceForConnection(connectionId)).getIssue(issueKey);
      const settings = getSettingsBackend().read();
      return runLocalPeerReview(issue, {
        provider: 'vercel-gateway',
        credential: gateway.apiKey,
        gatewayUrl: gateway.gatewayUrl,
        agentName: settings.ai.agentName.trim() || 'AI Agent',
        workingDirectory: settings.ai.workingDirectory.trim() || undefined
      });
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
