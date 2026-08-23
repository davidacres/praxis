import { BrowserWindow, ipcMain } from 'electron';
import {
  GitLabApiService,
  buildDeliveryTaskDefinition,
  buildFeatureDecompositionTaskDefinition,
  buildMergeRequestFeedbackTaskDefinition,
  buildSubTaskDeliveryTaskDefinition,
  discoverWorkspaceAgentWorkflows,
  extractDeliveryBaseBranch,
  isFeatureRequestTicket,
  isTicketManagerManagedMergeRequestNote,
  parseDeliveryTaskResult,
  parseFeatureDecompositionResult,
  parseMergeRequestFeedbackResult,
  resolveDeliveryPublishCommand,
  resolveWorkflowReference,
  reviewTicketWithVercelGateway,
  validateDeliveryWorkflowSettings,
  wrapTicketManagerManagedMergeRequestNote,
  type AgentSessionRecord,
  type AiAnalysisMessage,
  type AiAnalysisState,
  type DeliverySessionMetadata,
  type FeatureSubTaskRecord,
  type IssueDetails
} from '@ticket-manager/core';
import {
  getAiAnalysisStore,
  getAiSessionManager,
  getVercelAgentService,
  resolveGatewayOptions
} from './aiInstance';
import type { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { DesktopGitLabConfigProvider } from './adapters/desktopGitLabConfigProvider';
import { getConnectionStore } from './connectionStoreInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { getServiceForConnection } from './serviceRegistry';

export const ANALYSIS_STORAGE_KEY = 'ticketManager.issueAnalysis';

/** Persisted subset of AiAnalysisState (`busy` is runtime-only). */
interface StoredAnalysis {
  messages: AiAnalysisMessage[];
  confirmed: boolean;
  confirmedAt?: string;
  model?: string;
}

function readAnalysisMap(store: JsonKeyValueStore): Record<string, StoredAnalysis> {
  return store.get<Record<string, StoredAnalysis>>(ANALYSIS_STORAGE_KEY) ?? {};
}

/** Gate check shared with aiIpc's delegate handler. */
export function isAnalysisConfirmed(store: JsonKeyValueStore, issueKey: string): boolean {
  return readAnalysisMap(store)[issueKey]?.confirmed === true;
}

/** Issue keys whose workflow session was started with this connection (for watcher callbacks). */
const sessionConnections = new Map<string, string | undefined>();

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

/**
 * Registers the AI workflow IPC: the per-issue analysis chat, the delivery and
 * feature-decomposition runs, and the GitLab merge-request actions. Also owns
 * the completion watcher that finalizes workflow sessions (parses the agent's
 * structured result, creates decomposed sub-tasks, posts MR replies).
 */
export function registerAiWorkflowIpc(): void {
  const sessionManager = getAiSessionManager();
  const agentService = getVercelAgentService();
  const analysisStore = getAiAnalysisStore();
  const analysisControllers = new Map<string, AbortController>();
  const busyAnalysis = new Set<string>();

  function toAnalysisState(issueKey: string): AiAnalysisState {
    const stored = readAnalysisMap(analysisStore)[issueKey];
    return {
      issueKey,
      messages: stored?.messages ?? [],
      confirmed: stored?.confirmed ?? false,
      confirmedAt: stored?.confirmedAt,
      busy: busyAnalysis.has(issueKey),
      model: stored?.model
    };
  }

  async function writeAnalysis(issueKey: string, mutate: (stored: StoredAnalysis) => StoredAnalysis): Promise<void> {
    const map = readAnalysisMap(analysisStore);
    const current = map[issueKey] ?? { messages: [], confirmed: false };
    map[issueKey] = mutate(current);
    await analysisStore.update(ANALYSIS_STORAGE_KEY, map);
    broadcast('ai:analysisChanged', toAnalysisState(issueKey));
  }

  // ── Issue analysis (chat) ─────────────────────────────────────────────────

  ipcMain.handle('ai:getAnalysis', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) =>
    toAnalysisState(issueKey)
  );

  ipcMain.handle(
    'ai:submitAnalysis',
    async (
      _event: Electron.IpcMainInvokeEvent,
      issueKey: string,
      question: string,
      connectionId?: string
    ) => {
      const settings = getSettingsBackend().read();
      const analysisPrompt = settings.ai.analysisPrompt.trim();
      if (!analysisPrompt) {
        throw new Error('Set an analysis system prompt under Settings → AI Provider first.');
      }
      const gateway = await resolveGatewayOptions();
      if (!gateway.apiKey) {
        throw new Error(
          'No Vercel AI Gateway API key configured. Add one under Settings → AI Provider.'
        );
      }
      if (busyAnalysis.has(issueKey)) {
        throw new Error(`An analysis run is already in progress for ${issueKey}.`);
      }

      const issue = await (await getServiceForConnection(connectionId)).getIssue(issueKey);
      const trimmedQuestion = question.trim();

      analysisControllers.get(issueKey)?.abort();
      const controller = new AbortController();
      analysisControllers.set(issueKey, controller);
      busyAnalysis.add(issueKey);

      const userMessage: AiAnalysisMessage = {
        role: 'user',
        text: trimmedQuestion || 'Run the analysis.',
        createdAt: new Date().toISOString()
      };
      const assistantMessage: AiAnalysisMessage = {
        role: 'assistant',
        text: '',
        createdAt: new Date().toISOString()
      };
      await writeAnalysis(issueKey, stored => ({
        ...stored,
        messages: [...stored.messages, userMessage, assistantMessage]
      }));

      try {
        // Same shape as the extension's analysis run: the question and the
        // conversation so far are folded into a synthetic issue description,
        // then the review service runs it under the analysis system prompt.
        const history = readAnalysisMap(analysisStore)[issueKey]?.messages ?? [];
        const historyText = history
          .slice(0, -2) // exclude the user/assistant pair just appended
          .map(entry => `${entry.role.toUpperCase()}: ${entry.text}`)
          .join('\n\n');
        const appendedPrompt = [
          trimmedQuestion ? `Question: ${trimmedQuestion}` : 'Analyze this ticket.',
          historyText ? `Conversation so far:\n${historyText}` : undefined
        ]
          .filter((part): part is string => Boolean(part))
          .join('\n\n');
        const issueForAnalysis: IssueDetails = {
          ...issue,
          description: [issue.description ?? '', appendedPrompt].filter(Boolean).join('\n\n')
        };
        const answer = await reviewTicketWithVercelGateway(
          issueForAnalysis,
          gateway.apiKey,
          settings.ai.agentName.trim() || 'AI Agent',
          {
            gatewayUrl: gateway.gatewayUrl,
            model: gateway.model,
            systemPrompt: analysisPrompt,
            signal: controller.signal,
            onUpdate: content => {
              // Stream into the trailing assistant message. Fire-and-forget:
              // writes are ordered by the single run per issue.
              void writeAnalysis(issueKey, stored => {
                const messages = [...stored.messages];
                messages[messages.length - 1] = { ...assistantMessage, text: content };
                return { ...stored, messages };
              });
            }
          }
        );
        await writeAnalysis(issueKey, stored => {
          const messages = [...stored.messages];
          messages[messages.length - 1] = { ...assistantMessage, text: answer };
          return { ...stored, messages, model: gateway.model };
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await writeAnalysis(issueKey, stored => {
          const messages = [...stored.messages];
          messages[messages.length - 1] = {
            ...assistantMessage,
            text: `Analysis failed: ${message}`
          };
          return { ...stored, messages };
        });
        throw error;
      } finally {
        busyAnalysis.delete(issueKey);
        analysisControllers.delete(issueKey);
        broadcast('ai:analysisChanged', toAnalysisState(issueKey));
      }
    }
  );

  ipcMain.handle('ai:cancelAnalysis', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) => {
    analysisControllers.get(issueKey)?.abort();
  });

  ipcMain.handle(
    'ai:setAnalysisConfirmed',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, confirmed: boolean) => {
      await writeAnalysis(issueKey, stored => ({
        ...stored,
        confirmed,
        confirmedAt: confirmed ? new Date().toISOString() : undefined
      }));
    }
  );

  ipcMain.handle('ai:clearAnalysis', async (_event: Electron.IpcMainInvokeEvent, issueKey: string) => {
    analysisControllers.get(issueKey)?.abort();
    const map = readAnalysisMap(analysisStore);
    delete map[issueKey];
    await analysisStore.update(ANALYSIS_STORAGE_KEY, map);
    broadcast('ai:analysisChanged', toAnalysisState(issueKey));
  });

  // ── Delivery / decomposition ──────────────────────────────────────────────

  function requireGatewayAndWorkingDirectory(gateway: { apiKey?: string }): string {
    if (!gateway.apiKey) {
      throw new Error(
        'No Vercel AI Gateway API key configured. Add one under Settings → AI Provider.'
      );
    }
    const workingDirectory = getSettingsBackend().read().ai.workingDirectory.trim();
    if (!workingDirectory) {
      throw new Error('Set the AI working directory under Settings → AI Provider first.');
    }
    return workingDirectory;
  }

  function requireConfirmedAnalysis(issueKey: string): void {
    if (
      getSettingsBackend().read().ai.analysisGateEnabled &&
      !isAnalysisConfirmed(analysisStore, issueKey)
    ) {
      throw new Error(
        `Analysis for ${issueKey} must be confirmed before starting delivery (the analysis gate is enabled in Settings → AI Provider).`
      );
    }
  }

  function resolveBaseBranch(issue: IssueDetails): string {
    const settings = getSettingsBackend().read();
    const baseBranch =
      extractDeliveryBaseBranch(issue) ?? settings.delivery.defaultBaseBranch.trim() ?? '';
    if (!baseBranch) {
      throw new Error(
        'No base branch: add one to the issue (e.g. "Base branch: main") or set a default under Settings → Delivery.'
      );
    }
    return baseBranch;
  }

  ipcMain.handle(
    'ai:startDelivery',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, connectionId?: string) => {
      const settings = getSettingsBackend().read();
      const validationErrors = validateDeliveryWorkflowSettings({
        enabled: settings.delivery.enabled,
        publishCommand: settings.delivery.publishCommand,
        artifactPattern: settings.delivery.artifactPattern
      });
      if (validationErrors.length > 0) {
        throw new Error(validationErrors.join('\n'));
      }
      const gateway = await resolveGatewayOptions();
      const workingDirectory = requireGatewayAndWorkingDirectory(gateway);
      requireConfirmedAnalysis(issueKey);

      const issue = await (await getServiceForConnection(connectionId)).getIssue(issueKey);
      const baseBranch = resolveBaseBranch(issue);
      const branchName = issue.branch?.trim() || `feature/${issueKey.toLowerCase()}`;
      const workflow = sessionManager.getIssueWorkflowAssignment(issueKey)?.workflow;
      const publishCommand = resolveDeliveryPublishCommand(
        settings.delivery.publishCommand,
        workingDirectory
      );
      const taskDefinition = buildDeliveryTaskDefinition(issue, {
        baseBranch,
        branchName,
        worktreePath: workingDirectory,
        publishCommand,
        artifactPattern: settings.delivery.artifactPattern,
        workflow
      });
      sessionConnections.set(issueKey, connectionId);
      await agentService.startTask(issue, taskDefinition, {
        apiKey: gateway.apiKey,
        gatewayUrl: gateway.gatewayUrl,
        workingDirectory,
        model: gateway.model
      });
      sessionManager.updateAgentDelivery(issueKey, {
        source: 'jira-polling',
        phase: 'implementation',
        baseBranch,
        worktreeName: branchName,
        worktreePath: workingDirectory,
        createdBranch: branchName,
        publishCommand,
        artifactPattern: settings.delivery.artifactPattern,
        finalizationState: 'pending'
      });
      return sessionManager.getAgentSession(issueKey);
    }
  );

  ipcMain.handle(
    'ai:decomposeFeature',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, connectionId?: string) => {
      const gateway = await resolveGatewayOptions();
      const workingDirectory = requireGatewayAndWorkingDirectory(gateway);
      requireConfirmedAnalysis(issueKey);

      const issue = await (await getServiceForConnection(connectionId)).getIssue(issueKey);
      if (!isFeatureRequestTicket(issue)) {
        throw new Error(
          `${issueKey} is not marked as a feature request (its description must mention "feature request").`
        );
      }
      const baseBranch = resolveBaseBranch(issue);
      const availableWorkflows = await discoverWorkspaceAgentWorkflows(workingDirectory);
      const workflow = sessionManager.getIssueWorkflowAssignment(issueKey)?.workflow;
      const taskDefinition = buildFeatureDecompositionTaskDefinition(issue, {
        baseBranch,
        worktreePath: workingDirectory,
        availableWorkflows,
        workflow
      });
      sessionConnections.set(issueKey, connectionId);
      await agentService.startTask(issue, taskDefinition, {
        apiKey: gateway.apiKey,
        gatewayUrl: gateway.gatewayUrl,
        workingDirectory,
        model: gateway.model
      });
      sessionManager.updateAgentDelivery(issueKey, {
        source: 'jira-polling',
        phase: 'feature-decomposition',
        baseBranch,
        worktreeName: '',
        worktreePath: workingDirectory,
        createdBranch: '',
        publishCommand: '',
        artifactPattern: '',
        finalizationState: 'pending'
      });
      return sessionManager.getAgentSession(issueKey);
    }
  );

  ipcMain.handle(
    'ai:startSubTaskDelivery',
    async (
      _event: Electron.IpcMainInvokeEvent,
      parentIssueKey: string,
      subTaskKey: string,
      connectionId?: string
    ) => {
      const gateway = await resolveGatewayOptions();
      const workingDirectory = requireGatewayAndWorkingDirectory(gateway);

      const parentDelivery = sessionManager.getAgentSession(parentIssueKey)?.delivery;
      const decomposition = parentDelivery?.featureDecomposition;
      if (!decomposition) {
        throw new Error(`${parentIssueKey} has no recorded feature decomposition.`);
      }
      const subTaskRecord = decomposition.subTasks.find(record => record.issueKey === subTaskKey);
      if (!subTaskRecord) {
        throw new Error(`${subTaskKey} is not a recorded sub-task of ${parentIssueKey}.`);
      }

      const issue = await (await getServiceForConnection(connectionId)).getIssue(subTaskKey);
      const branchName = issue.branch?.trim() || `feature/${subTaskKey.toLowerCase()}`;
      const taskDefinition = buildSubTaskDeliveryTaskDefinition(issue, {
        baseBranch: decomposition.featureBranch,
        branchName,
        worktreePath: workingDirectory,
        workflow: subTaskRecord.workflow
      });
      sessionConnections.set(subTaskKey, connectionId);
      await agentService.startTask(issue, taskDefinition, {
        apiKey: gateway.apiKey,
        gatewayUrl: gateway.gatewayUrl,
        workingDirectory,
        model: gateway.model
      });
      sessionManager.updateAgentDelivery(subTaskKey, {
        source: 'jira-polling',
        phase: 'implementation',
        baseBranch: decomposition.featureBranch,
        worktreeName: branchName,
        worktreePath: workingDirectory,
        createdBranch: branchName,
        publishCommand: '',
        artifactPattern: '',
        finalizationState: 'pending',
        parentFeatureIssueKey: parentIssueKey
      });
      // Reflect the running state on the parent's sub-task list.
      updateSubTaskRecord(parentIssueKey, subTaskKey, {
        deliveryState: 'in-progress',
        worktreeBranch: branchName
      });
      return sessionManager.getAgentSession(subTaskKey);
    }
  );

  function updateSubTaskRecord(
    parentIssueKey: string,
    subTaskKey: string,
    patch: Partial<FeatureSubTaskRecord>
  ): void {
    const parentDelivery = sessionManager.getAgentSession(parentIssueKey)?.delivery;
    const decomposition = parentDelivery?.featureDecomposition;
    if (!decomposition) {
      return;
    }
    sessionManager.updateAgentDelivery(parentIssueKey, {
      featureDecomposition: {
        ...decomposition,
        subTasks: decomposition.subTasks.map(record =>
          record.issueKey === subTaskKey ? { ...record, ...patch } : record
        )
      }
    });
  }

  // ── Merge requests (GitLab) ───────────────────────────────────────────────

  async function buildGitLabApi(connectionId: string): Promise<GitLabApiService> {
    const store = getConnectionStore();
    const connection = store.getConnection(connectionId);
    if (!connection || connection.mode !== 'gitlab') {
      throw new Error('Merge requests require a GitLab connection.');
    }
    const provider = new DesktopGitLabConfigProvider(connection);
    const baseUrl = provider.getGitLabUrl();
    const projectPath = provider.getGitLabProjectPath();
    const token =
      (await store.getSecret(connectionId, 'gitlabApiKey')) ??
      (await store.getSecret(connectionId, 'apiKey')) ??
      provider.getGitLabApiKey().trim();
    if (!baseUrl || !projectPath || !token) {
      throw new Error('The GitLab connection is missing its URL, project path, or API key.');
    }
    return new GitLabApiService({ baseUrl, projectPath, token });
  }

  ipcMain.handle(
    'ai:listMergeRequests',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, connectionId: string) =>
      (await buildGitLabApi(connectionId)).listMergeRequestsForIssue(issueKey)
  );

  ipcMain.handle(
    'ai:createMergeRequest',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, connectionId: string) => {
      const api = await buildGitLabApi(connectionId);
      const issue = await (await getServiceForConnection(connectionId)).getIssue(issueKey);
      const delivery = sessionManager.getAgentSession(issueKey)?.delivery;
      const sourceBranch = delivery?.createdBranch?.trim() || issue.branch?.trim() || '';
      if (!sourceBranch) {
        throw new Error(`No branch is recorded for ${issueKey} — run a delivery first.`);
      }
      const existing = await api.listMergeRequestsForSourceBranch(sourceBranch);
      const open = existing.find(mergeRequest => mergeRequest.state === 'opened');
      if (open) {
        return open;
      }
      const mergeRequest = await api.createMergeRequest({
        sourceBranch,
        targetBranch: delivery?.baseBranch?.trim() || 'main',
        title: `${issue.key}: ${issue.summary}`,
        description: issue.description?.slice(0, 2000),
        removeSourceBranch: true
      });
      if (delivery) {
        sessionManager.updateAgentDelivery(issueKey, {
          mergeRequest: {
            iid: mergeRequest.iid,
            webUrl: mergeRequest.webUrl,
            title: mergeRequest.title,
            sourceBranch: mergeRequest.sourceBranch,
            targetBranch: mergeRequest.targetBranch,
            state: mergeRequest.state,
            createdAt: mergeRequest.createdAt,
            updatedAt: mergeRequest.updatedAt,
            lastSeenAt: new Date().toISOString()
          }
        });
      }
      return mergeRequest;
    }
  );

  ipcMain.handle(
    'ai:checkMergeRequestFeedback',
    async (_event: Electron.IpcMainInvokeEvent, issueKey: string, connectionId: string) => {
      const api = await buildGitLabApi(connectionId);
      const mergeRequests = await api.listMergeRequestsForIssue(issueKey);
      const open = mergeRequests.find(mergeRequest => mergeRequest.state === 'opened');
      if (!open) {
        return { started: false, noteCount: 0 };
      }
      const notes = (await api.listMergeRequestDiscussions(open.iid)).filter(
        note => !note.system && !isTicketManagerManagedMergeRequestNote(note.body)
      );
      const handled = sessionManager.getAgentSession(issueKey)?.delivery?.mergeRequest?.handledNotes ?? {};
      const fresh = notes.filter(note => handled[note.id] !== note.updatedAt);
      if (fresh.length === 0) {
        return { started: false, noteCount: 0 };
      }

      const gateway = await resolveGatewayOptions();
      const workingDirectory = requireGatewayAndWorkingDirectory(gateway);
      const issue = await (await getServiceForConnection(connectionId)).getIssue(issueKey);
      const workflow = sessionManager.getIssueWorkflowAssignment(issueKey)?.workflow;
      const taskDefinition = buildMergeRequestFeedbackTaskDefinition(issue, {
        branchName: open.sourceBranch,
        worktreePath: workingDirectory,
        mergeRequestUrl: open.webUrl,
        sourceBranch: open.sourceBranch,
        targetBranch: open.targetBranch,
        notes: fresh.map(note => ({ author: note.author, body: note.body, updatedAt: note.updatedAt })),
        workflow
      });
      sessionConnections.set(issueKey, connectionId);
      await agentService.startTask(issue, taskDefinition, {
        apiKey: gateway.apiKey,
        gatewayUrl: gateway.gatewayUrl,
        workingDirectory,
        model: gateway.model
      });
      // Mark the addressed notes handled up-front; the completion watcher posts the reply.
      const handledNotes = { ...handled };
      for (const note of fresh) {
        handledNotes[note.id] = note.updatedAt;
      }
      sessionManager.updateAgentDelivery(issueKey, {
        source: 'jira-polling',
        phase: 'merge-request-feedback',
        baseBranch: open.targetBranch,
        worktreeName: open.sourceBranch,
        worktreePath: workingDirectory,
        createdBranch: open.sourceBranch,
        publishCommand: '',
        artifactPattern: '',
        finalizationState: 'pending',
        mergeRequest: {
          iid: open.iid,
          webUrl: open.webUrl,
          title: open.title,
          sourceBranch: open.sourceBranch,
          targetBranch: open.targetBranch,
          state: open.state,
          createdAt: open.createdAt,
          updatedAt: open.updatedAt,
          handledNotes,
          lastSeenAt: new Date().toISOString()
        }
      });
      return { started: true, noteCount: fresh.length };
    }
  );

  // ── Completion watcher ────────────────────────────────────────────────────
  // Registered alongside the channels; the delivery metadata's
  // finalizationState === 'pending' guard keeps the updateAgentDelivery calls
  // below from re-entering finalization (each fires onDidChangeAgentSession).

  sessionManager.onDidChangeAgentSession((record: AgentSessionRecord) => {
    if (record.state !== 'completed' && record.state !== 'failed' && record.state !== 'aborted') {
      return;
    }
    const delivery = record.delivery;
    if (!delivery || delivery.finalizationState !== 'pending') {
      return;
    }
    void finalizeWorkflowSession(record, delivery).catch(error => {
      console.warn(
        `[ai-workflows] finalization failed for ${record.issueKey}: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  });

  async function finalizeWorkflowSession(
    record: AgentSessionRecord,
    delivery: DeliverySessionMetadata
  ): Promise<void> {
    const issueKey = record.issueKey;

    if (record.state !== 'completed') {
      sessionManager.updateAgentDelivery(issueKey, {
        finalizationState: 'failed',
        finalizationMessage: `Agent session ended in state "${record.state}".`
      });
      if (delivery.parentFeatureIssueKey) {
        updateSubTaskRecord(delivery.parentFeatureIssueKey, issueKey, { deliveryState: 'failed' });
      }
      return;
    }

    switch (delivery.phase) {
      case 'implementation': {
        const result = parseDeliveryTaskResult(record.responseText);
        if (!result) {
          sessionManager.updateAgentDelivery(issueKey, {
            finalizationState: 'failed',
            finalizationMessage: 'The agent finished without a parseable DELIVERY_RESULT block.'
          });
        } else {
          sessionManager.updateAgentDelivery(issueKey, {
            finalizationState: result.status === 'success' ? 'completed' : 'failed',
            finalizationMessage:
              result.status === 'success'
                ? result.summary
                : result.failureReason ?? result.summary,
            result,
            uploadedArtifactNames: result.artifactPaths
          });
        }
        if (delivery.parentFeatureIssueKey) {
          updateSubTaskRecord(delivery.parentFeatureIssueKey, issueKey, {
            deliveryState: result?.status === 'success' ? 'completed' : 'failed'
          });
        }
        return;
      }

      case 'feature-decomposition': {
        const result = parseFeatureDecompositionResult(record.responseText);
        if (!result || result.status !== 'decomposed') {
          sessionManager.updateAgentDelivery(issueKey, {
            finalizationState: 'failed',
            finalizationMessage:
              result?.blockers?.join('; ') ||
              'The agent finished without a parseable FEATURE_DECOMPOSITION_RESULT block.'
          });
          return;
        }
        const connectionId = sessionConnections.get(issueKey);
        const service = await getServiceForConnection(connectionId);
        const availableWorkflows = await discoverWorkspaceAgentWorkflows(delivery.worktreePath);
        const subTasks: FeatureSubTaskRecord[] = [];
        for (const subTask of result.subTasks) {
          const created = await service.createIssue({
            projectKey: issueKey.split('-')[0] ?? issueKey,
            issueType: subTask.issueType || 'Task',
            summary: subTask.summary,
            description: subTask.description,
            parentKey: issueKey
          });
          const workflow = resolveWorkflowReference(subTask.suggestedWorkflow, availableWorkflows);
          if (workflow) {
            sessionManager.setIssueWorkflowAssignment(created.key, workflow, {
              source: 'analysis',
              reason: 'Suggested by the feature decomposition run.'
            });
          }
          subTasks.push({
            issueKey: created.key,
            summary: created.summary,
            order: subTask.order,
            workflow,
            deliveryState: 'pending'
          });
        }
        sessionManager.updateAgentDelivery(issueKey, {
          finalizationState: 'completed',
          finalizationMessage: result.summary,
          createdBranch: result.featureBranch,
          featureDecomposition: {
            parentIssueKey: issueKey,
            featureBranch: result.featureBranch,
            baseBranch: delivery.baseBranch,
            subTasks,
            decompositionSummary: result.summary
          }
        });
        return;
      }

      case 'merge-request-feedback': {
        const result = parseMergeRequestFeedbackResult(record.responseText);
        if (!result || result.status !== 'success') {
          sessionManager.updateAgentDelivery(issueKey, {
            finalizationState: 'failed',
            finalizationMessage:
              result?.failureReason ??
              'The agent finished without a parseable MERGE_REQUEST_FEEDBACK_RESULT block.'
          });
          return;
        }
        const connectionId = sessionConnections.get(issueKey);
        if (result.replyComment && connectionId && delivery.mergeRequest) {
          const api = await buildGitLabApi(connectionId);
          await api.addMergeRequestNote(
            delivery.mergeRequest.iid,
            wrapTicketManagerManagedMergeRequestNote(result.replyComment)
          );
        }
        sessionManager.updateAgentDelivery(issueKey, {
          finalizationState: 'completed',
          finalizationMessage: result.summary
        });
        return;
      }

      case 'analysis': {
        // Delivery-phase analysis sessions carry their own result marker; on
        // desktop the analysis chat (not a delivery session) is the primary
        // analysis surface, so just close the finalization out.
        sessionManager.updateAgentDelivery(issueKey, {
          finalizationState: 'completed',
          finalizationMessage: 'Analysis session completed.'
        });
        return;
      }
    }
  }
}
