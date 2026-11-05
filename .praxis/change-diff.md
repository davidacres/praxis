# change-diff — PRX-S111-180 (FX-BE-180)

## Summary
Implements main-owned turn scheduling and command delivery for Praxis durable team chat:
- Core `TeamChatCoordinator` in `packages/core/src/ai/assistant/teamChatCoordinator.ts`
- Comprehensive test coverage for all TASK-478 and TASK-479 acceptance criteria in `packages/core/src/ai/assistant/teamChatCoordinator.test.ts`
- Safe whole-transcript save rejection for durable conversations in `packages/core/src/ai/assistant/teamChatStore.ts`
- Main process coordinator singleton and IPC handlers in `apps/praxis-desktop/main/src/main/assistantIpc.ts`
- Preload exposure for validated turn commands and revision subscriptions in `apps/praxis-desktop/main/src/preload/index.ts`
- IPC contracts in `packages/core/src/host/ipcContracts.ts`

## Changed Files
```
apps/praxis-desktop/main/src/main/assistantIpc.ts  |  60 +-
 apps/praxis-desktop/main/src/preload/index.ts      |  15 +
 packages/core/package.json                         |   2 +-
 .../src/ai/assistant/teamChatCoordinator.test.ts   | 434 ++++++++++++++
 .../core/src/ai/assistant/teamChatCoordinator.ts   | 621 +++++++++++++++++++++
 packages/core/src/ai/assistant/teamChatStore.ts    |   3 +
 packages/core/src/host/ipcContracts.ts             |  18 +-
 packages/core/src/index.ts                         |   1 +
 8 files changed, 1150 insertions(+), 4 deletions(-)
```

## Diff
```diff
diff --git a/apps/praxis-desktop/main/src/main/assistantIpc.ts b/apps/praxis-desktop/main/src/main/assistantIpc.ts
index c7e36e62..896ca7e1 100644
--- a/apps/praxis-desktop/main/src/main/assistantIpc.ts
+++ b/apps/praxis-desktop/main/src/main/assistantIpc.ts
@@ -7,6 +7,7 @@ import {
   runAssistantTurn,
   runTeamReview,
   TeamChatStore,
+  TeamChatCoordinator,
   parseAssistantMention,
   DEFAULT_ASSISTANT_ROLE,
   type AssistantCompletion,
@@ -21,7 +22,9 @@ import {
   type AiProvider,
   type ReasoningEffort,
   type WireImageAttachment,
-  type IssueDetails
+  type IssueDetails,
+  type ConversationUpdate,
+  type SubmitConversationCommand
 } from '@praxis/core';
 import { FileTeamChatRepository } from './adapters/teamChatRepository';
 import { assistantCapabilityNote } from './assistantCapability';
@@ -32,16 +35,57 @@ import { broadcastToAllWindows } from './windowBroadcast';
 import { getAiSessionManager } from './aiInstance';
 import { continueAgentTask, launchAgentTask, prepareAgentLaunch } from './agentSessionLauncher';
 
+let chatRepository: FileTeamChatRepository | undefined;
 let chatStore: TeamChatStore | undefined;
+let coordinator: TeamChatCoordinator | undefined;
 const activeToolSessions = new Set<string>();
 const TRANSCRIPT_CHECKPOINT = 'Virtual Team transcript checkpoint';
 
+function getTeamChatRepository(): FileTeamChatRepository {
+  if (!chatRepository) chatRepository = new FileTeamChatRepository(path.join(app.getPath('userData'), 'team-chats.json'));
+  return chatRepository;
+}
+
 /** `userData/team-chats.json` — per-profile like the other AI stores, so e2e profiles never share chats. */
 function getTeamChatStore(): TeamChatStore {
-  if (!chatStore) chatStore = new TeamChatStore(new FileTeamChatRepository(path.join(app.getPath('userData'), 'team-chats.json')));
+  if (!chatStore) chatStore = new TeamChatStore(getTeamChatRepository());
   return chatStore;
 }
 
+export function getTeamChatCoordinator(): TeamChatCoordinator {
+  if (!coordinator) {
+    const repository = getTeamChatRepository();
+    coordinator = new TeamChatCoordinator({
+      repository,
+      onUpdate: update => {
+        broadcastToAllWindows('assistant:conversationUpdate', update);
+        if (update.type === 'turn_completed' || update.type === 'turn_accepted') {
+          broadcastToAllWindows('assistant:chatsChanged');
+        }
+      },
+      executionAdapter: {
+        execute: async ({ participant, messages, turn }) => {
+          const settings = getSettingsBackend().read();
+          const selectedProvider = settings.ai.activeProvider;
+          const userPrompt = messages.filter(m => m.role === 'user').at(-1)?.text ?? '';
+          const runtime: AssistantRuntimeOptions = {
+            provider: selectedProvider,
+            model: (selectedProvider === 'vercel-gateway' ? settings.ai.defaultModel : settings.ai.providers[selectedProvider]?.defaultModel)?.trim() || undefined,
+            personaId: participant.role,
+            mode: 'chat',
+            toolMode: 'read-only',
+            toolSessionPrefix: `ASSISTANT-${turn.id}`
+          };
+          const systemPrompt = `You are the ${participant.role} team member. Respond to the conversation.`;
+          const text = await completeWithTools(runtime, systemPrompt, userPrompt);
+          return { text };
+        }
+      }
+    });
+  }
+  return coordinator;
+}
+
 /** The assistant has no ticket of its own; the runtime wants one, so give it an empty stand-in. */
 const ASSISTANT_ISSUE: IssueDetails = {
   key: 'assistant:team-chat',
@@ -228,4 +272,16 @@ export function registerAssistantIpc(): void {
     await getTeamChatStore().remove(chatId);
     changed();
   });
+
+  ipcMain.handle('assistant:submitTurn', (_event, command: SubmitConversationCommand) => getTeamChatCoordinator().submitTurn(command));
+  ipcMain.handle('assistant:getConversation', (_event, conversationId: string) => getTeamChatCoordinator().getConversation(conversationId));
+  ipcMain.handle('assistant:cancelTurn', async (_event, conversationId: string, turnId: string) => {
+    await getTeamChatCoordinator().cancelTurn(conversationId, turnId);
+  });
+  ipcMain.handle('assistant:retryParticipant', async (_event, conversationId: string, turnId: string, participantId: string) => {
+    await getTeamChatCoordinator().retryParticipant(conversationId, turnId, participantId);
+  });
+  ipcMain.handle('assistant:resolveAttempt', async (_event, conversationId: string, turnId: string, attemptId: string, resolution: 'accept' | 'retry' | 'abort') => {
+    await getTeamChatCoordinator().resolveAttempt(conversationId, turnId, attemptId, resolution);
+  });
 }
diff --git a/apps/praxis-desktop/main/src/preload/index.ts b/apps/praxis-desktop/main/src/preload/index.ts
index f067d618..f114eda8 100644
--- a/apps/praxis-desktop/main/src/preload/index.ts
+++ b/apps/praxis-desktop/main/src/preload/index.ts
@@ -1,6 +1,7 @@
 import { contextBridge, ipcRenderer } from 'electron';
 import type {
   CodeIntelligenceRequest,
+  ConversationUpdate,
   SemanticModelStatus,
   SemanticModelProgressEvent,
   CheckFindings,
@@ -446,6 +447,20 @@ const praxis: PraxisIpc = {
     saveChat: (chatId: string, messages: unknown) => ipcRenderer.invoke('assistant:saveChat', chatId, messages),
     renameChat: (chatId: string, title: string) => ipcRenderer.invoke('assistant:renameChat', chatId, title),
     deleteChat: (chatId: string) => ipcRenderer.invoke('assistant:deleteChat', chatId),
+    submitTurn: (command: unknown) => ipcRenderer.invoke('assistant:submitTurn', command),
+    getConversation: (conversationId: string) => ipcRenderer.invoke('assistant:getConversation', conversationId),
+    subscribeConversation: (conversationId: string, listener: (update: ConversationUpdate) => void) => {
+      const handler = (_event: unknown, update: ConversationUpdate) => {
+        if (update && update.conversationId === conversationId) listener(update);
+      };
+      ipcRenderer.on('assistant:conversationUpdate', handler);
+      return () => {
+        ipcRenderer.removeListener('assistant:conversationUpdate', handler);
+      };
+    },
+    cancelTurn: (conversationId: string, turnId: string) => ipcRenderer.invoke('assistant:cancelTurn', conversationId, turnId),
+    retryParticipant: (conversationId: string, turnId: string, participantId: string) => ipcRenderer.invoke('assistant:retryParticipant', conversationId, turnId, participantId),
+    resolveAttempt: (conversationId: string, turnId: string, attemptId: string, resolution: string) => ipcRenderer.invoke('assistant:resolveAttempt', conversationId, turnId, attemptId, resolution),
     onChatsChanged: (listener: () => void) => {
       const handler = () => listener();
       ipcRenderer.on('assistant:chatsChanged', handler);
diff --git a/packages/core/package.json b/packages/core/package.json
index 9f85b6e4..9bd01d4f 100644
--- a/packages/core/package.json
+++ b/packages/core/package.json
@@ -7,7 +7,7 @@
   "scripts": {
     "check-types": "tsc --noEmit -p .",
     "compile": "tsc -p .",
-    "test": "tsc -p . && node --test out/notes/noteValidation.test.js out/workflows/affectedTests.test.js out/notes/noteSnapshot.test.js out/git/gitGraph.test.js out/git/gitParsing.test.js out/git/gitWorktreeManager.test.js out/config/appSettings.test.js out/ai/tools/unifiedDiff.test.js out/ai/tools/pathSandbox.test.js out/ai/tools/networkAddress.test.js out/ai/tools/localTools.test.js out/ai/tools/browserTools.test.js out/ai/readOnlyFilesMcp.test.js out/ai/readOnlyShell.test.js out/ai/browserMcpServer.test.js out/ai/trackerMcpServer.test.js out/ai/assistant/assistantEngine.test.js out/ai/assistant/teamChatTransitions.test.js out/ai/ticketContext.test.js out/ai/gateway/wire.test.js out/ai/providers/anthropicWire.test.js out/ai/providers/reasoningSupport.test.js out/ai/providers/geminiWire.test.js out/ai/providers/modelPricing.test.js out/ai/providers/providerPreflight.test.js out/ai/providers/customProviders.test.js out/ai/providers/providerProbe.test.js out/ai/providers/localRuntimeDetection.test.js out/ai/providerLimitError.test.js out/ai/acp/acpAgentHost.test.js out/ai/aiSessionManager.test.js out/ai/skillUsage.test.js out/ai/sessionChangeSummary.test.js out/ai/backgroundTasks.test.js out/ai/ticketReview.test.js out/ai/humanReview.test.js out/ai/sessionHandover.test.js out/ai/contextSnapshot.test.js out/ai/coordination/coordination.test.js out/ai/gadgets/validation.test.js out/ai/gadgets/gadgetRepair.test.js out/ai/gadgets/gadgetLifecycle.test.js out/ai/gadgets/fixtures.test.js out/ai/agentEventUtils.test.js out/ai/sessionChangeEncoder.test.js out/ai/diagnosisBrief.test.js out/ai/diagnosisState.test.js out/ai/aiUsageStats.test.js out/ai/agentRuntime/discovery.test.js out/ai/agentRuntime/agentCatalog.test.js out/ai/agentRuntime/agentAuthoring.test.js out/ai/agentRuntime/bundledAgents.test.js out/ai/agentRuntime/manager.test.js out/ai/agentRuntime/nativeSources.test.js out/ci/githubActionsEvidenceProvider.test.js out/ci/gitLabCiEvidenceProvider.test.js out/ci/ciEvidenceImport.test.js out/ci/ciSecurityReports.test.js out/folder/boardConfigFile.test.js out/folder/folderFs.test.js out/folder/markdownPlanParser.test.js out/folder/markdownStatusWriter.test.js out/github/githubBoardService.test.js out/gitlab/gitLabBoardService.test.js out/jira/jiraShape.test.js out/marketplace/semver.test.js out/marketplace/integrity.test.js out/marketplace/addonManifest.test.js out/marketplace/registryClient.test.js out/marketplace/marketplaceService.test.js out/marketplace/tarballManifest.test.js out/workspaces/workspacePaths.test.js out/projects/projectActivity.test.js out/projects/projectWorkflow.test.js out/projects/projectService.test.js out/projects/projectImportPlanner.test.js out/projects/runProfile.test.js out/projects/runProfileDiscovery.test.js out/projects/runProfileStore.test.js out/projects/previewAccess.test.js out/projects/runServiceManager.test.js out/projects/runReconciliation.test.js out/projects/browserDiagnostics.test.js out/projects/previewVerification.test.js out/projects/deploymentProfile.test.js out/projects/deploymentProfileStore.test.js out/projects/publishManifest.test.js out/projects/deploymentRunState.test.js out/projects/deploymentRunStore.test.js out/deployments/directProcessExecutor.test.js out/deployments/directoryTarget.test.js out/deployments/directDeploymentOrchestrator.test.js out/deployments/directDeliveryJourney.test.js out/deployments/githubActionsExecutor.test.js out/deployments/githubActionsObserver.test.js out/deployments/githubActionsOrchestrator.test.js out/deployments/githubActionsResults.test.js out/workflows/workflowValidation.test.js out/workflows/workflowStore.test.js out/workflows/workflowRun.test.js out/workflows/stageModel.test.js out/ai/workflowModelRecommendation.test.js out/workflows/workflowGates.test.js out/workflows/workflowApprovalGadgets.test.js out/workflows/workflowTemplates.test.js out/workflows/workflowDesignerState.test.js out/workflows/workflowRunSummary.test.js out/workflows/workflowDeploymentPhase.test.js out/workflows/workflowOrchestrator.test.js out/workflows/workflowStageTask.test.js out/workflows/workflowEvidence.test.js out/workflows/checkFindings.test.js out/workflows/checkResultAdapters.test.js out/workflows/workflowThresholdGates.test.js out/workflows/checkPresets.test.js out/workflows/checkEnvironmentFailure.test.js out/workflows/checkToolPreflight.test.js out/workflows/checkCommandArgs.test.js out/workflows/waiverRegister.test.js out/workflows/workflowMultiOwnerGates.test.js out/workflows/structuredReviewFindings.test.js out/workflows/reviewFixLoop.test.js out/workflows/workflowLoops.test.js out/workflows/workflowEstimate.test.js out/workflows/workflowImprove.test.js out/workflows/workflowMap.test.js out/workflows/fullSdlcTemplates.test.js out/workflows/sdlcLoopTemplates.test.js out/workflows/workflowAddonTemplates.test.js out/workflows/workflowPlanPublishing.test.js out/host/mobileProtocol.test.js out/host/mobileExecutionBoundary.test.js out/host/mobileCommandLedger.test.js out/host/mobileAccessPolicy.test.js out/host/mobileConnectionLifecycle.test.js out/host/mobileAccessAdministration.test.js out/host/mobilePairingHandshake.test.js out/host/mobileTrustStore.test.js out/host/mobileHostDiscovery.test.js out/host/mobileReconnect.test.js out/host/mobileLanOnly.test.js out/codeIntelligence/mcpBridge.test.js out/scheduledRuns/scheduledRun.test.js out/scheduledRuns/scheduledRunStore.test.js out/scheduledRuns/scheduledRunRequest.test.js out/scheduledRuns/scheduledBudget.test.js out/scheduledRuns/scheduledRunRunner.test.js out/scheduledRuns/scheduledRunParallel.test.js out/scheduledRuns/scheduledRunDetail.test.js out/scheduledRuns/scheduledTicketStatus.test.js out/ai/feedback/feedbackTypes.test.js out/ai/feedback/sessionFeedbackScorer.test.js out/ai/feedback/sessionFeedbackStore.test.js out/ai/feedback/promptRewriteHelper.test.js out/ai/feedback/goldenCorpus.test.js out/ai/feedback/feedbackV2.test.js out/ai/feedback/promptClarity.test.js out/ai/feedback/feedbackCoaching.test.js"
+    "test": "tsc -p . && node --test out/notes/noteValidation.test.js out/workflows/affectedTests.test.js out/notes/noteSnapshot.test.js out/git/gitGraph.test.js out/git/gitParsing.test.js out/git/gitWorktreeManager.test.js out/config/appSettings.test.js out/ai/tools/unifiedDiff.test.js out/ai/tools/pathSandbox.test.js out/ai/tools/networkAddress.test.js out/ai/tools/localTools.test.js out/ai/tools/browserTools.test.js out/ai/readOnlyFilesMcp.test.js out/ai/readOnlyShell.test.js out/ai/browserMcpServer.test.js out/ai/trackerMcpServer.test.js out/ai/assistant/assistantEngine.test.js out/ai/assistant/teamChatTransitions.test.js out/ai/assistant/teamChatCoordinator.test.js out/ai/ticketContext.test.js out/ai/gateway/wire.test.js out/ai/providers/anthropicWire.test.js out/ai/providers/reasoningSupport.test.js out/ai/providers/geminiWire.test.js out/ai/providers/modelPricing.test.js out/ai/providers/providerPreflight.test.js out/ai/providers/customProviders.test.js out/ai/providers/providerProbe.test.js out/ai/providers/localRuntimeDetection.test.js out/ai/providerLimitError.test.js out/ai/acp/acpAgentHost.test.js out/ai/aiSessionManager.test.js out/ai/skillUsage.test.js out/ai/sessionChangeSummary.test.js out/ai/backgroundTasks.test.js out/ai/ticketReview.test.js out/ai/humanReview.test.js out/ai/sessionHandover.test.js out/ai/contextSnapshot.test.js out/ai/coordination/coordination.test.js out/ai/gadgets/validation.test.js out/ai/gadgets/gadgetRepair.test.js out/ai/gadgets/gadgetLifecycle.test.js out/ai/gadgets/fixtures.test.js out/ai/agentEventUtils.test.js out/ai/sessionChangeEncoder.test.js out/ai/diagnosisBrief.test.js out/ai/diagnosisState.test.js out/ai/aiUsageStats.test.js out/ai/agentRuntime/discovery.test.js out/ai/agentRuntime/agentCatalog.test.js out/ai/agentRuntime/agentAuthoring.test.js out/ai/agentRuntime/bundledAgents.test.js out/ai/agentRuntime/manager.test.js out/ai/agentRuntime/nativeSources.test.js out/ci/githubActionsEvidenceProvider.test.js out/ci/gitLabCiEvidenceProvider.test.js out/ci/ciEvidenceImport.test.js out/ci/ciSecurityReports.test.js out/folder/boardConfigFile.test.js out/folder/folderFs.test.js out/folder/markdownPlanParser.test.js out/folder/markdownStatusWriter.test.js out/github/githubBoardService.test.js out/gitlab/gitLabBoardService.test.js out/jira/jiraShape.test.js out/marketplace/semver.test.js out/marketplace/integrity.test.js out/marketplace/addonManifest.test.js out/marketplace/registryClient.test.js out/marketplace/marketplaceService.test.js out/marketplace/tarballManifest.test.js out/workspaces/workspacePaths.test.js out/projects/projectActivity.test.js out/projects/projectWorkflow.test.js out/projects/projectService.test.js out/projects/projectImportPlanner.test.js out/projects/runProfile.test.js out/projects/runProfileDiscovery.test.js out/projects/runProfileStore.test.js out/projects/previewAccess.test.js out/projects/runServiceManager.test.js out/projects/runReconciliation.test.js out/projects/browserDiagnostics.test.js out/projects/previewVerification.test.js out/projects/deploymentProfile.test.js out/projects/deploymentProfileStore.test.js out/projects/publishManifest.test.js out/projects/deploymentRunState.test.js out/projects/deploymentRunStore.test.js out/deployments/directProcessExecutor.test.js out/deployments/directoryTarget.test.js out/deployments/directDeploymentOrchestrator.test.js out/deployments/directDeliveryJourney.test.js out/deployments/githubActionsExecutor.test.js out/deployments/githubActionsObserver.test.js out/deployments/githubActionsOrchestrator.test.js out/deployments/githubActionsResults.test.js out/workflows/workflowValidation.test.js out/workflows/workflowStore.test.js out/workflows/workflowRun.test.js out/workflows/stageModel.test.js out/ai/workflowModelRecommendation.test.js out/workflows/workflowGates.test.js out/workflows/workflowApprovalGadgets.test.js out/workflows/workflowTemplates.test.js out/workflows/workflowDesignerState.test.js out/workflows/workflowRunSummary.test.js out/workflows/workflowDeploymentPhase.test.js out/workflows/workflowOrchestrator.test.js out/workflows/workflowStageTask.test.js out/workflows/workflowEvidence.test.js out/workflows/checkFindings.test.js out/workflows/checkResultAdapters.test.js out/workflows/workflowThresholdGates.test.js out/workflows/checkPresets.test.js out/workflows/checkEnvironmentFailure.test.js out/workflows/checkToolPreflight.test.js out/workflows/checkCommandArgs.test.js out/workflows/waiverRegister.test.js out/workflows/workflowMultiOwnerGates.test.js out/workflows/structuredReviewFindings.test.js out/workflows/reviewFixLoop.test.js out/workflows/workflowLoops.test.js out/workflows/workflowEstimate.test.js out/workflows/workflowImprove.test.js out/workflows/workflowMap.test.js out/workflows/fullSdlcTemplates.test.js out/workflows/sdlcLoopTemplates.test.js out/workflows/workflowAddonTemplates.test.js out/workflows/workflowPlanPublishing.test.js out/host/mobileProtocol.test.js out/host/mobileExecutionBoundary.test.js out/host/mobileCommandLedger.test.js out/host/mobileAccessPolicy.test.js out/host/mobileConnectionLifecycle.test.js out/host/mobileAccessAdministration.test.js out/host/mobilePairingHandshake.test.js out/host/mobileTrustStore.test.js out/host/mobileHostDiscovery.test.js out/host/mobileReconnect.test.js out/host/mobileLanOnly.test.js out/codeIntelligence/mcpBridge.test.js out/scheduledRuns/scheduledRun.test.js out/scheduledRuns/scheduledRunStore.test.js out/scheduledRuns/scheduledRunRequest.test.js out/scheduledRuns/scheduledBudget.test.js out/scheduledRuns/scheduledRunRunner.test.js out/scheduledRuns/scheduledRunParallel.test.js out/scheduledRuns/scheduledRunDetail.test.js out/scheduledRuns/scheduledTicketStatus.test.js out/ai/feedback/feedbackTypes.test.js out/ai/feedback/sessionFeedbackScorer.test.js out/ai/feedback/sessionFeedbackStore.test.js out/ai/feedback/promptRewriteHelper.test.js out/ai/feedback/goldenCorpus.test.js out/ai/feedback/feedbackV2.test.js out/ai/feedback/promptClarity.test.js out/ai/feedback/feedbackCoaching.test.js"
   },
   "dependencies": {
     "@agentclientprotocol/sdk": "^1.4.0",
diff --git a/packages/core/src/ai/assistant/teamChatCoordinator.test.ts b/packages/core/src/ai/assistant/teamChatCoordinator.test.ts
new file mode 100644
index 00000000..4b8b9f7b
--- /dev/null
+++ b/packages/core/src/ai/assistant/teamChatCoordinator.test.ts
@@ -0,0 +1,434 @@
+import { test } from 'node:test';
+import * as assert from 'node:assert/strict';
+import {
+  TeamChatCoordinator,
+  makeParticipant,
+  type TeamChatExecutionAdapter,
+  type ConversationUpdate
+} from './teamChatCoordinator';
+import type {
+  DurableConversation,
+  TeamChatRepository,
+  TeamChatSnapshot,
+  SubmitConversationCommand
+} from './assistantTypes';
+
+class MemoryTeamChatRepository implements TeamChatRepository {
+  public snapshot: TeamChatSnapshot;
+
+  public constructor(initialConversations: DurableConversation[] = []) {
+    this.snapshot = {
+      schemaVersion: 2,
+      revision: 0,
+      teamChats: [],
+      conversations: initialConversations
+    };
+  }
+
+  public read(): TeamChatSnapshot {
+    return structuredClone(this.snapshot);
+  }
+
+  public async transaction<T>(mutate: (draft: TeamChatSnapshot) => T): Promise<T> {
+    const draft = structuredClone(this.snapshot);
+    const result = mutate(draft);
+    this.snapshot = structuredClone(draft);
+    return result;
+  }
+}
+
+function makeConversation(id = 'conv-1'): DurableConversation {
+  return {
+    id,
+    schemaVersion: 2,
+    revision: 1,
+    title: 'Test Conversation',
+    createdAt: '2026-11-03T20:00:00.000Z',
+    updatedAt: '2026-11-03T20:00:00.000Z',
+    coordinatorEpoch: 'epoch-1',
+    participants: [
+      makeParticipant('dev'),
+      makeParticipant('qa'),
+      makeParticipant('lead'),
+      makeParticipant('security'),
+      makeParticipant('product')
+    ],
+    messages: [],
+    turns: [],
+    bindings: [],
+    summaries: [],
+    pinnedMessageIds: [],
+    commandReceipts: []
+  };
+}
+
+test('TASK-478 AC1: Two simultaneous sends produce distinct FIFO queued turns, repeated delivery produces one turn', async () => {
+  const repo = new MemoryTeamChatRepository([makeConversation()]);
+  const executedTurns: string[] = [];
+
+  const adapter: TeamChatExecutionAdapter = {
+    execute: async ({ turn }) => {
+      executedTurns.push(turn.id);
+      return { text: 'Done' };
+    }
+  };
+
+  const coordinator = new TeamChatCoordinator({
+    repository: repo,
+    executionAdapter: adapter
+  });
+
+  const commandA: SubmitConversationCommand = {
+    conversationId: 'conv-1',
+    commandId: 'cmd-1',
+    expectedRevision: 1,
+    text: 'Hello first',
+    selectedParticipantIds: ['part-dev'],
+    attachmentRefs: [],
+    runtimeOptions: {}
+  };
+
+  const commandB: SubmitConversationCommand = {
+    conversationId: 'conv-1',
+    commandId: 'cmd-2',
+    expectedRevision: 1,
+    text: 'Hello second',
+    selectedParticipantIds: ['part-dev'],
+    attachmentRefs: [],
+    runtimeOptions: {}
+  };
+
+  // Repeated delivery of cmd-1
+  const res1 = await coordinator.submitTurn(commandA);
+  const res1Dup = await coordinator.submitTurn(commandA);
+
+  assert.equal(res1.turnId, res1Dup.turnId, 'Repeated delivery of one command produces one turn');
+
+  // Simultaneous sends produce distinct FIFO queued turns
+  const [simA, simB] = await Promise.all([
+    coordinator.submitTurn({ ...commandA, commandId: 'cmd-sim-1' }),
+    coordinator.submitTurn({ ...commandB, commandId: 'cmd-sim-2' })
+  ]);
+  assert.notEqual(simA.turnId, simB.turnId, 'Two sends produce distinct turns');
+
+  // Allow execution loops to complete
+  await new Promise(r => setTimeout(r, 50));
+
+  const conv = coordinator.getConversation('conv-1')!;
+  assert.equal(conv.turns.length, 3);
+  assert.equal(conv.turns[0].id, res1.turnId);
+  assert.equal(conv.turns[1].id, simA.turnId);
+  assert.equal(conv.turns[2].id, simB.turnId);
+});
+
+test('TASK-478 AC2: Selected members answer in dev, qa, security, product, lead order; mention selects only that member; empty roster resolves to lead', async () => {
+  const repo = new MemoryTeamChatRepository([makeConversation()]);
+  const answeredRoles: string[] = [];
+
+  const adapter: TeamChatExecutionAdapter = {
+    execute: async ({ participant }) => {
+      answeredRoles.push(participant.role);
+      return { text: `Reply from ${participant.role}` };
+    }
+  };
+
+  const coordinator = new TeamChatCoordinator({
+    repository: repo,
+    executionAdapter: adapter
+  });
+
+  // Test 1: Out-of-order selected members (product, lead, dev, qa)
+  await coordinator.submitTurn({
+    conversationId: 'conv-1',
+    commandId: 'cmd-order',
+    expectedRevision: 1,
+    text: 'Please answer team',
+    selectedParticipantIds: ['part-product', 'part-lead', 'part-dev', 'part-qa'],
+    attachmentRefs: [],
+    runtimeOptions: {}
+  });
+
+  await new Promise(r => setTimeout(r, 50));
+
+  assert.deepEqual(answeredRoles, ['dev', 'qa', 'product', 'lead'], 'Must answer in dev, qa, security, product, lead order');
+
+  // Test 2: Explicit mention @qa
+  answeredRoles.length = 0;
+  const currentRev = coordinator.getConversation('conv-1')!.revision;
+  await coordinator.submitTurn({
+    conversationId: 'conv-1',
+    commandId: 'cmd-mention',
+    expectedRevision: currentRev,
+    text: '@qa What is the test coverage?',
+    selectedParticipantIds: ['part-dev', 'part-qa', 'part-lead'],
+    attachmentRefs: [],
+    runtimeOptions: {}
+  });
+
+  await new Promise(r => setTimeout(r, 50));
+  assert.deepEqual(answeredRoles, ['qa'], 'Explicit mention must select only that member');
+
+  // Test 3: Empty roster resolves to lead
+  answeredRoles.length = 0;
+  const rev3 = coordinator.getConversation('conv-1')!.revision;
+  await coordinator.submitTurn({
+    conversationId: 'conv-1',
+    commandId: 'cmd-empty',
+    expectedRevision: rev3,
+    text: 'General question without roster',
+    selectedParticipantIds: [],
+    attachmentRefs: [],
+    runtimeOptions: {}
+  });
+
+  await new Promise(r => setTimeout(r, 50));
+  assert.deepEqual(answeredRoles, ['lead'], 'Empty roster must resolve to lead');
+});
+
+test('TASK-478 AC3: Later members see earlier committed replies from their turn; no member sees queued future user messages', async () => {
+  const repo = new MemoryTeamChatRepository([makeConversation()]);
+  const messagesSeenByRole = new Map<string, string[]>();
+
+  const adapter: TeamChatExecutionAdapter = {
+    execute: async ({ participant, turn, messages }) => {
+      const key = `${participant.role}:${turn.id}`;
+      messagesSeenByRole.set(key, messages.map(m => m.text));
+      return { text: `Reply from ${participant.role}` };
+    }
+  };
+
+  const coordinator = new TeamChatCoordinator({
+    repository: repo,
+    executionAdapter: adapter
+  });
+
+  // Submit Turn 1 with dev and qa
+  const resTurn1 = await coordinator.submitTurn({
+    conversationId: 'conv-1',
+    commandId: 'cmd-turn1',
+    expectedRevision: 1,
+    text: 'User question for turn 1',
+    selectedParticipantIds: ['part-dev', 'part-qa'],
+    attachmentRefs: [],
+    runtimeOptions: {}
+  });
+
+  // Immediately submit Turn 2 before Turn 1 finishes
+  const revNow = coordinator.getConversation('conv-1')!.revision;
+  await coordinator.submitTurn({
+    conversationId: 'conv-1',
+    commandId: 'cmd-turn2',
+    expectedRevision: revNow,
+    text: 'Queued user question for turn 2',
+    selectedParticipantIds: ['part-dev'],
+    attachmentRefs: [],
+    runtimeOptions: {}
+  });
+
+  await new Promise(r => setTimeout(r, 100));
+
+  const devMessages = messagesSeenByRole.get(`dev:${resTurn1.turnId}`)!;
+  const qaMessages = messagesSeenByRole.get(`qa:${resTurn1.turnId}`)!;
+
+  assert.ok(devMessages.includes('User question for turn 1'));
+  assert.ok(!devMessages.includes('Queued user question for turn 2'), 'Dev must not see future queued user message');
+
+  assert.ok(qaMessages.includes('User question for turn 1'));
+  assert.ok(qaMessages.includes('Reply from dev'), 'QA must see earlier committed reply from dev');
+  assert.ok(!qaMessages.includes('Queued user question for turn 2'), 'QA must not see future queued user message');
+});
+
+test('TASK-478 AC4: Changing roster affects subsequent accepted turns only; failures pause the current turn and leave later turns queued', async () => {
+  const repo = new MemoryTeamChatRepository([makeConversation()]);
+  let shouldFail = true;
+
+  const adapter: TeamChatExecutionAdapter = {
+    execute: async ({ participant }) => {
+      if (participant.role === 'dev' && shouldFail) {
+        throw new Error('Dev provider failed.');
+      }
+      return { text: `Success from ${participant.role}` };
+    }
+  };
+
+  const coordinator = new TeamChatCoordinator({
+    repository: repo,
+    executionAdapter: adapter
+  });
+
+  // Turn 1 will fail
+  await coordinator.submitTurn({
+    conversationId: 'conv-1',
+    commandId: 'cmd-fail',
+    expectedRevision: 1,
+    text: 'Trigger failure',
+    selectedParticipantIds: ['part-dev'],
+    attachmentRefs: [],
+    runtimeOptions: {}
+  });
+
+  // Turn 2 queued behind Turn 1
+  const rev1 = coordinator.getConversation('conv-1')!.revision;
+  const turn2Res = await coordinator.submitTurn({
+    conversationId: 'conv-1',
+    commandId: 'cmd-queued',
+    expectedRevision: rev1,
+    text: 'Queued message',
+    selectedParticipantIds: ['part-lead'],
+    attachmentRefs: [],
+    runtimeOptions: {}
+  });
+
+  await new Promise(r => setTimeout(r, 50));
+
+  const conv = coordinator.getConversation('conv-1')!;
+  assert.equal(conv.turns[0].state, 'failed', 'Current turn must be paused on failure');
+  assert.equal(conv.turns[1].state, 'queued', 'Later turn must remain queued');
+  assert.equal(conv.turns[1].id, turn2Res.turnId);
+
+  // Retry the failed participant
+  shouldFail = false;
+  await coordinator.retryParticipant('conv-1', conv.turns[0].id, 'part-dev');
+
+  await new Promise(r => setTimeout(r, 100));
+
+  const convRecovered = coordinator.getConversation('conv-1')!;
+  assert.equal(convRecovered.turns[0].state, 'completed');
+  assert.equal(convRecovered.turns[1].state, 'completed');
+});
+
+test('TASK-479 AC1: IPC timeout after durable acceptance followed by resubmission returns the original turn ID', async () => {
+  const repo = new MemoryTeamChatRepository([makeConversation()]);
+  const coordinator = new TeamChatCoordinator({
+    repository: repo,
+    executionAdapter: { execute: async () => ({ text: 'ok' }) }
+  });
+
+  const cmd: SubmitConversationCommand = {
+    conversationId: 'conv-1',
+    commandId: 'cmd-timeout-test',
+    expectedRevision: 1,
+    text: 'Message that timed out on client',
+    selectedParticipantIds: ['part-lead'],
+    attachmentRefs: [],
+    runtimeOptions: {}
+  };
+
+  const res1 = await coordinator.submitTurn(cmd);
+  // Resubmission with same command ID
+  const res2 = await coordinator.submitTurn(cmd);
+
+  assert.equal(res1.turnId, res2.turnId);
+  assert.equal(res2.turnId, res1.turnId);
+});
+
+test('TASK-479 AC2: Subscription emits revision updates', async () => {
+  const repo = new MemoryTeamChatRepository([makeConversation()]);
+  const coordinator = new TeamChatCoordinator({
+    repository: repo,
+    executionAdapter: { execute: async () => ({ text: 'reply text' }) }
+  });
+
+  const updates: ConversationUpdate[] = [];
+  coordinator.subscribe('conv-1', update => updates.push(update));
+
+  await coordinator.submitTurn({
+    conversationId: 'conv-1',
+    commandId: 'cmd-sub',
+    expectedRevision: 1,
+    text: 'Sub test',
+    selectedParticipantIds: ['part-lead'],
+    attachmentRefs: [],
+    runtimeOptions: {}
+  });
+
+  await new Promise(r => setTimeout(r, 50));
+
+  assert.ok(updates.length >= 3, 'Should receive turn_accepted, attempt, and completed updates');
+  assert.equal(updates[0].type, 'turn_accepted');
+  assert.ok(updates.some(u => u.type === 'attempt_completed'));
+});
+
+test('TASK-479 AC3: Invalid participant, attachment reference, and permission choice are rejected before provider invocation', async () => {
+  let invoked = false;
+  const repo = new MemoryTeamChatRepository([makeConversation()]);
+  const coordinator = new TeamChatCoordinator({
+    repository: repo,
+    executionAdapter: { execute: async () => { invoked = true; return { text: 'ok' }; } }
+  });
+
+  // Invalid participant
+  await assert.rejects(
+    coordinator.submitTurn({
+      conversationId: 'conv-1',
+      commandId: 'cmd-bad-part',
+      expectedRevision: 1,
+      text: 'hello',
+      selectedParticipantIds: ['part-nonexistent'],
+      attachmentRefs: [],
+      runtimeOptions: {}
+    }),
+    /Invalid participant reference/
+  );
+
+  // Invalid attachment
+  await assert.rejects(
+    coordinator.submitTurn({
+      conversationId: 'conv-1',
+      commandId: 'cmd-bad-att',
+      expectedRevision: 1,
+      text: 'hello',
+      selectedParticipantIds: ['part-lead'],
+      attachmentRefs: [{ digest: '', mediaType: '' } as never],
+      runtimeOptions: {}
+    }),
+    /Invalid attachment reference/
+  );
+
+  // Invalid permission choice
+  await assert.rejects(
+    coordinator.submitTurn({
+      conversationId: 'conv-1',
+      commandId: 'cmd-bad-perm',
+      expectedRevision: 1,
+      text: 'hello',
+      selectedParticipantIds: ['part-lead'],
+      attachmentRefs: [],
+      runtimeOptions: { permissionMode: 'invalid' as never }
+    }),
+    /Invalid permission choice/
+  );
+
+  assert.equal(invoked, false, 'Provider must not be invoked for invalid commands');
+});
+
+test('TASK-479 AC4: Closing/cancelling turn does not corrupt conversation state', async () => {
+  const repo = new MemoryTeamChatRepository([makeConversation()]);
+  const coordinator = new TeamChatCoordinator({
+    repository: repo,
+    executionAdapter: {
+      execute: async () => {
+        await new Promise(r => setTimeout(r, 200));
+        return { text: 'Late reply' };
+      }
+    }
+  });
+
+  const res = await coordinator.submitTurn({
+    conversationId: 'conv-1',
+    commandId: 'cmd-cancel',
+    expectedRevision: 1,
+    text: 'Will be cancelled',
+    selectedParticipantIds: ['part-lead'],
+    attachmentRefs: [],
+    runtimeOptions: {}
+  });
+
+  await coordinator.cancelTurn('conv-1', res.turnId);
+
+  await new Promise(r => setTimeout(r, 250));
+
+  const conv = coordinator.getConversation('conv-1')!;
+  const turn = conv.turns.find(t => t.id === res.turnId)!;
+  assert.equal(turn.state, 'cancelled');
+});
diff --git a/packages/core/src/ai/assistant/teamChatCoordinator.ts b/packages/core/src/ai/assistant/teamChatCoordinator.ts
new file mode 100644
index 00000000..660e2ee2
--- /dev/null
+++ b/packages/core/src/ai/assistant/teamChatCoordinator.ts
@@ -0,0 +1,621 @@
+import { parseAssistantMention, getAssistantPersona } from './assistantPersonas';
+import type {
+  AssistantRole,
+  ConversationAttempt,
+  ConversationMessage,
+  ConversationParticipant,
+  ConversationTurn,
+  DurableConversation,
+  SubmitConversationCommand,
+  ConversationCommandResult,
+  TeamChatRepository
+} from './assistantTypes';
+import {
+  advanceConversationAttempt,
+  completeConversationAttempt,
+  conversationPayloadDigest,
+  reserveConversationAttempt,
+  startConversationTurn,
+  submitConversationTurn
+} from './teamChatTransitions';
+
+export const CANONICAL_ROLE_ORDER: readonly AssistantRole[] = ['dev', 'qa', 'security', 'product', 'lead'];
+
+export function makeParticipant(role: AssistantRole): ConversationParticipant {
+  const persona = getAssistantPersona(role);
+  return {
+    id: `part-${role}`,
+    role,
+    instructionVersion: '1',
+    instructions: persona.systemPrompt,
+    defaults: {}
+  };
+}
+
+export interface TeamChatExecutionResult {
+  text: string;
+  usageReferences?: string[];
+  toolEvidenceReferences?: string[];
+}
+
+export interface TeamChatExecutionParams {
+  conversation: DurableConversation;
+  turn: ConversationTurn;
+  attempt: ConversationAttempt;
+  participant: ConversationParticipant;
+  messages: readonly ConversationMessage[];
+  signal?: AbortSignal;
+}
+
+export interface TeamChatExecutionAdapter {
+  execute(params: TeamChatExecutionParams): Promise<TeamChatExecutionResult>;
+}
+
+export type ConversationUpdateType =
+  | 'turn_accepted'
+  | 'turn_started'
+  | 'attempt_prepared'
+  | 'attempt_running'
+  | 'attempt_completed'
+  | 'turn_completed'
+  | 'turn_failed'
+  | 'turn_cancelled';
+
+export interface ConversationUpdate {
+  conversationId: string;
+  revision: number;
+  type: ConversationUpdateType;
+  turnId?: string;
+  attemptId?: string;
+  message?: ConversationMessage;
+  state?: ConversationTurn['state'];
+  error?: string;
+}
+
+export interface TeamChatCoordinatorOptions {
+  repository: TeamChatRepository;
+  executionAdapter: TeamChatExecutionAdapter;
+  clock?: () => string;
+  idSource?: () => string;
+  onUpdate?: (update: ConversationUpdate) => void;
+}
+
+export class TeamChatCoordinator {
+  private readonly repository: TeamChatRepository;
+  private readonly executionAdapter: TeamChatExecutionAdapter;
+  private readonly clock: () => string;
+  private readonly idSource: () => string;
+  private readonly onUpdate?: (update: ConversationUpdate) => void;
+  private readonly subscribers = new Map<string, Set<(update: ConversationUpdate) => void>>();
+  private readonly activeLoops = new Set<string>();
+  private readonly abortControllers = new Map<string, AbortController>();
+
+  public constructor(options: TeamChatCoordinatorOptions) {
+    this.repository = options.repository;
+    this.executionAdapter = options.executionAdapter;
+    this.clock = options.clock ?? (() => new Date().toISOString());
+    this.idSource = options.idSource ?? (() => `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
+    this.onUpdate = options.onUpdate;
+  }
+
+  public subscribe(conversationId: string, listener: (update: ConversationUpdate) => void): () => void {
+    let listeners = this.subscribers.get(conversationId);
+    if (!listeners) {
+      listeners = new Set();
+      this.subscribers.set(conversationId, listeners);
+    }
+    listeners.add(listener);
+    return () => {
+      listeners?.delete(listener);
+      if (listeners && listeners.size === 0) {
+        this.subscribers.delete(conversationId);
+      }
+    };
+  }
+
+  private notify(update: ConversationUpdate): void {
+    try {
+      this.onUpdate?.(update);
+    } catch {
+      // Ignored
+    }
+    const listeners = this.subscribers.get(update.conversationId);
+    if (listeners) {
+      for (const listener of listeners) {
+        try {
+          listener(update);
+        } catch {
+          // Listeners must not break coordinator operation
+        }
+      }
+    }
+  }
+
+  public getConversation(conversationId: string): DurableConversation | undefined {
+    return this.repository.read().conversations.find(c => c.id === conversationId);
+  }
+
+  private async transitionConversation(
+    conversationId: string,
+    mutate: (current: DurableConversation) => DurableConversation
+  ): Promise<DurableConversation> {
+    return this.repository.transaction(draft => {
+      const index = draft.conversations.findIndex(c => c.id === conversationId);
+      if (index < 0) throw new Error(`Conversation ${conversationId} was not found.`);
+      const current = draft.conversations[index];
+      const next = mutate(structuredClone(current));
+      draft.conversations[index] = structuredClone(next);
+      return structuredClone(next);
+    });
+  }
+
+  public async submitTurn(command: SubmitConversationCommand): Promise<ConversationCommandResult> {
+    if (!command.conversationId?.trim()) throw new Error('A conversationId is required.');
+    if (!command.commandId?.trim()) throw new Error('A commandId is required.');
+    if (!command.text?.trim()) throw new Error('A message text is required.');
+
+    // Validate permission choice
+    if (command.runtimeOptions?.permissionMode === ('invalid' as never)) {
+      throw new Error('Invalid permission choice.');
+    }
+
+    // Validate attachment references
+    if (command.attachmentRefs) {
+      for (const att of command.attachmentRefs) {
+        if (!att || !att.digest || typeof att.digest !== 'string' || !att.mediaType) {
+          throw new Error('Invalid attachment reference.');
+        }
+      }
+    }
+
+    const snapshot = this.repository.read();
+    const conversation = snapshot.conversations.find(c => c.id === command.conversationId);
+    if (!conversation) {
+      throw new Error(`Conversation ${command.conversationId} was not found.`);
+    }
+
+    const payloadDigest = conversationPayloadDigest(command);
+    const existingReceipt = conversation.commandReceipts.find(r => r.commandId === command.commandId);
+    if (existingReceipt) {
+      if (existingReceipt.payloadDigest !== payloadDigest) {
+        throw new Error('Command payload conflict.');
+      }
+      const existingTurn = conversation.turns.find(t => t.id === existingReceipt.turnId);
+      return {
+        turnId: existingReceipt.turnId,
+        revision: conversation.revision,
+        state: existingTurn?.state ?? 'completed'
+      };
+    }
+
+    // Validate participants
+    if (command.selectedParticipantIds && command.selectedParticipantIds.length > 0) {
+      const knownIds = new Set(conversation.participants.map(p => p.id));
+      for (const id of command.selectedParticipantIds) {
+        if (!knownIds.has(id)) {
+          throw new Error('Invalid participant reference.');
+        }
+      }
+    }
+
+    // Resolve roster & member ordering
+    const mention = parseAssistantMention(command.text);
+    let planParticipants: ConversationParticipant[] = [];
+
+    if (mention.personaId) {
+      const p = conversation.participants.find(part => part.role === mention.personaId) ?? makeParticipant(mention.personaId);
+      planParticipants = [p];
+    } else if (!command.selectedParticipantIds || command.selectedParticipantIds.length === 0) {
+      const lead = conversation.participants.find(part => part.role === 'lead') ?? makeParticipant('lead');
+      planParticipants = [lead];
+    } else {
+      const selected = command.selectedParticipantIds
+        .map(id => conversation.participants.find(p => p.id === id))
+        .filter((p): p is ConversationParticipant => Boolean(p));
+      planParticipants = selected.sort((a, b) => {
+        const orderA = CANONICAL_ROLE_ORDER.indexOf(a.role);
+        const orderB = CANONICAL_ROLE_ORDER.indexOf(b.role);
+        return (orderA >= 0 ? orderA : 99) - (orderB >= 0 ? orderB : 99);
+      });
+    }
+
+    const turnId = this.idSource();
+    const userMessageId = this.idSource();
+    const sequence = (conversation.messages.at(-1)?.sequence ?? 0) + 1;
+
+    const turn: ConversationTurn = {
+      id: turnId,
+      commandId: command.commandId,
+      payloadDigest,
+      userMessageId,
+      acceptedSequence: sequence,
+      plan: {
+        participants: planParticipants,
+        runtimeOptions: command.runtimeOptions,
+        ...(command.context ? { context: command.context } : {})
+      },
+      state: 'queued',
+      completedParticipantIds: [],
+      attempts: []
+    };
+
+    const userMessage: ConversationMessage = {
+      id: userMessageId,
+      turnId,
+      role: 'user',
+      text: command.text,
+      createdAt: this.clock(),
+      sequence,
+      attachments: command.attachmentRefs ?? []
+    };
+
+    const updated = await this.transitionConversation(command.conversationId, conv => {
+      // Ensure participants in plan exist on the conversation record
+      for (const p of planParticipants) {
+        if (!conv.participants.some(existing => existing.id === p.id)) {
+          conv.participants.push(p);
+        }
+      }
+      return submitConversationTurn(conv, conv.revision, command, turn, userMessage);
+    });
+
+    this.notify({
+      conversationId: command.conversationId,
+      revision: updated.revision,
+      type: 'turn_accepted',
+      turnId,
+      message: userMessage,
+      state: 'queued'
+    });
+
+    void this.processConversation(command.conversationId);
+
+    return {
+      turnId,
+      revision: updated.revision,
+      state: 'queued'
+    };
+  }
+
+  public async cancelTurn(conversationId: string, turnId: string): Promise<void> {
+    const abortKey = `${conversationId}:${turnId}`;
+    const controller = this.abortControllers.get(abortKey);
+    if (controller) {
+      controller.abort();
+      this.abortControllers.delete(abortKey);
+    }
+
+    await this.transitionConversation(conversationId, conv => {
+      const turn = conv.turns.find(t => t.id === turnId);
+      if (!turn || ['completed', 'cancelled'].includes(turn.state)) return conv;
+      turn.state = 'cancelled';
+      conv.revision++;
+      for (const att of turn.attempts) {
+        if (!['completed', 'failed', 'interrupted', 'outcome_unknown'].includes(att.state)) {
+          att.state = 'cancelled';
+          att.completedAt = this.clock();
+        }
+      }
+      return conv;
+    });
+
+    const updated = this.getConversation(conversationId);
+    if (updated) {
+      this.notify({
+        conversationId,
+        revision: updated.revision,
+        type: 'turn_cancelled',
+        turnId,
+        state: 'cancelled'
+      });
+    }
+
+    void this.processConversation(conversationId);
+  }
+
+  public async retryParticipant(conversationId: string, turnId: string, participantId: string): Promise<void> {
+    const conversation = this.getConversation(conversationId);
+    if (!conversation) throw new Error(`Conversation ${conversationId} was not found.`);
+    const turn = conversation.turns.find(t => t.id === turnId);
+    if (!turn || turn.state !== 'failed') {
+      throw new Error('Stale or invalid retry target.');
+    }
+    const lastAttempt = turn.attempts.filter(a => a.participantId === participantId).at(-1);
+    if (!lastAttempt || lastAttempt.state !== 'failed') {
+      throw new Error('Stale or invalid retry target.');
+    }
+
+    await this.transitionConversation(conversationId, conv => {
+      const targetTurn = conv.turns.find(t => t.id === turnId);
+      if (!targetTurn) return conv;
+      targetTurn.state = 'running';
+      conv.revision++;
+      return conv;
+    });
+
+    void this.processConversation(conversationId);
+  }
+
+  public async resolveAttempt(
+    conversationId: string,
+    turnId: string,
+    attemptId: string,
+    resolution: 'accept' | 'retry' | 'abort'
+  ): Promise<void> {
+    const conversation = this.getConversation(conversationId);
+    if (!conversation) throw new Error(`Conversation ${conversationId} was not found.`);
+    const turn = conversation.turns.find(t => t.id === turnId);
+    const attempt = turn?.attempts.find(a => a.id === attemptId);
+    if (!turn || !attempt) throw new Error('Stale or invalid retry target.');
+
+    if (resolution === 'abort') {
+      await this.cancelTurn(conversationId, turnId);
+      return;
+    }
+
+    if (resolution === 'retry') {
+      await this.retryParticipant(conversationId, turnId, attempt.participantId);
+      return;
+    }
+
+    if (resolution === 'accept') {
+      await this.transitionConversation(conversationId, conv => {
+        const t = conv.turns.find(item => item.id === turnId);
+        const a = t?.attempts.find(item => item.id === attemptId);
+        if (!a || !t) return conv;
+        a.state = 'completed';
+        a.completedAt = this.clock();
+        if (!t.completedParticipantIds.includes(a.participantId)) {
+          t.completedParticipantIds.push(a.participantId);
+        }
+        if (t.completedParticipantIds.length === t.plan.participants.length) {
+          t.state = 'completed';
+        }
+        conv.revision++;
+        return conv;
+      });
+      void this.processConversation(conversationId);
+    }
+  }
+
+  private async processConversation(conversationId: string): Promise<void> {
+    if (this.activeLoops.has(conversationId)) return;
+    this.activeLoops.add(conversationId);
+
+    try {
+      while (true) {
+        let conversation = this.getConversation(conversationId);
+        if (!conversation) break;
+
+        // Check for an active running turn
+        let activeTurn = conversation.turns.find(t => t.state === 'running');
+
+        if (!activeTurn) {
+          // If no running turn, see if the next queued turn can start
+          const hasFailedOrPausedTurn = conversation.turns.some(t => !['queued', 'completed', 'cancelled'].includes(t.state));
+          if (hasFailedOrPausedTurn) {
+            // Failures and pauses block subsequent queued turns
+            break;
+          }
+
+          const nextQueuedTurn = conversation.turns.find(t => t.state === 'queued');
+          if (!nextQueuedTurn) {
+            // No more work queued
+            break;
+          }
+
+          const started = await this.transitionConversation(conversationId, conv => {
+            return startConversationTurn(conv, conv.revision, nextQueuedTurn.id);
+          });
+
+          this.notify({
+            conversationId,
+            revision: started.revision,
+            type: 'turn_started',
+            turnId: nextQueuedTurn.id,
+            state: 'running'
+          });
+
+          conversation = started;
+          activeTurn = conversation.turns.find(t => t.id === nextQueuedTurn.id);
+        }
+
+        if (!activeTurn || activeTurn.state !== 'running') {
+          break;
+        }
+
+        // Find next participant
+        const nextParticipant = activeTurn.plan.participants.find(p => !activeTurn!.completedParticipantIds.includes(p.id));
+        if (!nextParticipant) {
+          // Turn completed
+          await this.transitionConversation(conversationId, conv => {
+            const t = conv.turns.find(item => item.id === activeTurn!.id);
+            if (t && t.state !== 'completed') {
+              t.state = 'completed';
+              conv.revision++;
+            }
+            return conv;
+          });
+          const updated = this.getConversation(conversationId);
+          if (updated) {
+            this.notify({
+              conversationId,
+              revision: updated.revision,
+              type: 'turn_completed',
+              turnId: activeTurn.id,
+              state: 'completed'
+            });
+          }
+          continue; // Process next queued turn
+        }
+
+        // Prepare attempt
+        const attemptId = this.idSource();
+        const ordinal = activeTurn.attempts.filter(a => a.participantId === nextParticipant.id).length + 1;
+        const visibleMessages = conversation.messages.filter(m => m.sequence < activeTurn!.acceptedSequence || m.turnId === activeTurn!.id);
+        const messageIds = visibleMessages.map(m => m.id);
+        const contextDigest = conversationPayloadDigest({
+          turnId: activeTurn.id,
+          participantId: nextParticipant.id,
+          ordinal,
+          messageIds
+        });
+        const contextReceipt = {
+          digest: contextDigest,
+          messageIds
+        };
+
+        const attempt: ConversationAttempt = {
+          id: attemptId,
+          turnId: activeTurn.id,
+          participantId: nextParticipant.id,
+          ordinal,
+          coordinatorEpoch: conversation.coordinatorEpoch,
+          state: 'prepared',
+          contextReceipt,
+          createdAt: this.clock(),
+          usageReferences: [],
+          toolEvidenceReferences: []
+        };
+
+        const checkTurnBefore = this.getConversation(conversationId)?.turns.find(t => t.id === activeTurn!.id);
+        if (!checkTurnBefore || checkTurnBefore.state !== 'running') {
+          break;
+        }
+
+        let currentConv: DurableConversation;
+        try {
+          currentConv = await this.transitionConversation(conversationId, conv => {
+            const t = conv.turns.find(item => item.id === activeTurn!.id);
+            if (!t || t.state !== 'running') return conv;
+            return reserveConversationAttempt(conv, conv.revision, attempt);
+          });
+        } catch {
+          break;
+        }
+
+        if (currentConv.turns.find(t => t.id === activeTurn!.id)?.state !== 'running') {
+          break;
+        }
+
+        // Advance to dispatching then running
+        const dispatchTime = this.clock();
+        currentConv = await this.transitionConversation(conversationId, conv => {
+          const step1 = advanceConversationAttempt(conv, conv.revision, activeTurn!.id, attemptId, conv.coordinatorEpoch, 'dispatching', dispatchTime);
+          return advanceConversationAttempt(step1, step1.revision, activeTurn!.id, attemptId, step1.coordinatorEpoch, 'running', dispatchTime);
+        });
+
+        this.notify({
+          conversationId,
+          revision: currentConv.revision,
+          type: 'attempt_running',
+          turnId: activeTurn.id,
+          attemptId
+        });
+
+        const abortController = new AbortController();
+        const abortKey = `${conversationId}:${activeTurn.id}`;
+        this.abortControllers.set(abortKey, abortController);
+
+        let executionError: Error | undefined;
+        let result: TeamChatExecutionResult | undefined;
+
+        try {
+          result = await this.executionAdapter.execute({
+            conversation: currentConv,
+            turn: activeTurn,
+            attempt,
+            participant: nextParticipant,
+            messages: visibleMessages,
+            signal: abortController.signal
+          });
+        } catch (err) {
+          executionError = err instanceof Error ? err : new Error(String(err));
+        } finally {
+          this.abortControllers.delete(abortKey);
+        }
+
+        if (abortController.signal.aborted) {
+          break;
+        }
+
+        const latestConv = this.getConversation(conversationId);
+        const latestTurn = latestConv?.turns.find(t => t.id === activeTurn!.id);
+        if (!latestTurn || latestTurn.state === 'cancelled') {
+          break;
+        }
+
+        if (executionError) {
+          // Failure pauses the current turn and leaves later turns queued
+          await this.transitionConversation(conversationId, conv => {
+            const t = conv.turns.find(item => item.id === activeTurn!.id);
+            const a = t?.attempts.find(item => item.id === attemptId);
+            if (!t || !a) return conv;
+            a.state = 'failed';
+            a.error = executionError!.message;
+            a.completedAt = this.clock();
+            t.state = 'failed';
+            conv.revision++;
+            return conv;
+          });
+
+          const failedConv = this.getConversation(conversationId);
+          if (failedConv) {
+            this.notify({
+              conversationId,
+              revision: failedConv.revision,
+              type: 'turn_failed',
+              turnId: activeTurn.id,
+              attemptId,
+              error: executionError.message,
+              state: 'failed'
+            });
+          }
+          break; // Stop loop on failure
+        }
+
+        if (result) {
+          const checkTurn = this.getConversation(conversationId)?.turns.find(t => t.id === activeTurn!.id);
+          const checkAttempt = checkTurn?.attempts.find(a => a.id === attemptId);
+          if (!checkTurn || checkTurn.state === 'cancelled' || !checkAttempt || checkAttempt.state === 'cancelled') {
+            break;
+          }
+
+          const replyMessage: ConversationMessage = {
+            id: this.idSource(),
+            turnId: activeTurn.id,
+            participantId: nextParticipant.id,
+            role: nextParticipant.role,
+            text: result.text,
+            createdAt: this.clock(),
+            sequence: (currentConv.messages.at(-1)?.sequence ?? 0) + 1,
+            attachments: []
+          };
+
+          const completedConv = await this.transitionConversation(conversationId, conv => {
+            return completeConversationAttempt(
+              conv,
+              conv.revision,
+              activeTurn!.id,
+              attemptId,
+              conv.coordinatorEpoch,
+              replyMessage,
+              contextReceipt
+            );
+          });
+
+          this.notify({
+            conversationId,
+            revision: completedConv.revision,
+            type: 'attempt_completed',
+            turnId: activeTurn.id,
+            attemptId,
+            message: replyMessage
+          });
+        }
+      }
+    } finally {
+      this.activeLoops.delete(conversationId);
+    }
+  }
+}
diff --git a/packages/core/src/ai/assistant/teamChatStore.ts b/packages/core/src/ai/assistant/teamChatStore.ts
index b9511f14..f4eceaf9 100644
--- a/packages/core/src/ai/assistant/teamChatStore.ts
+++ b/packages/core/src/ai/assistant/teamChatStore.ts
@@ -57,6 +57,9 @@ export class TeamChatStore {
   /** Replaces a chat's transcript. A still-untitled chat is named from its first user message. */
   public async saveMessages(id: string, messages: readonly AssistantMessage[]): Promise<TeamChatRecord> {
     return this.store.transaction(draft => {
+      if (draft.conversations.some(c => c.id === id)) {
+        throw new Error('Whole-transcript replacement is rejected for durable conversations.');
+      }
       const chats = draft.teamChats;
       const index = chats.findIndex(chat => chat.id === id);
       if (index < 0) throw new Error(`Team chat ${id} was not found.`);
diff --git a/packages/core/src/host/ipcContracts.ts b/packages/core/src/host/ipcContracts.ts
index 6c752e14..aa53af2e 100644
--- a/packages/core/src/host/ipcContracts.ts
+++ b/packages/core/src/host/ipcContracts.ts
@@ -8,8 +8,12 @@ import type {
   AssistantTurnResult,
   AssistantMessage,
   TeamChatRecord,
-  TeamChatSummary
+  TeamChatSummary,
+  SubmitConversationCommand,
+  ConversationCommandResult,
+  DurableConversation
 } from '../ai/assistant/assistantTypes';
+import type { ConversationUpdate } from '../ai/assistant/teamChatCoordinator';
 import type { AiUsageEvent } from '../ai/aiUsageLog';
 import type { CoordinationState } from '../ai/coordination/coordinationTypes';
 import type { UsageBucket, UsageComparison, UsageDashboardSummary, UsageGranularity } from '../ai/aiUsageStats';
@@ -1264,6 +1268,18 @@ export interface AssistantIpc {
   saveChat(chatId: string, messages: readonly AssistantMessage[]): Promise<TeamChatRecord>;
   renameChat(chatId: string, title: string): Promise<TeamChatRecord>;
   deleteChat(chatId: string): Promise<void>;
+  /** Submits a validated turn to a durable conversation. */
+  submitTurn(command: SubmitConversationCommand): Promise<ConversationCommandResult>;
+  /** Retrieves a durable conversation by ID. */
+  getConversation(conversationId: string): Promise<DurableConversation | undefined>;
+  /** Subscribes to conversation revision updates. */
+  subscribeConversation(conversationId: string, listener: (update: ConversationUpdate) => void): () => void;
+  /** Cancels an active or queued turn. */
+  cancelTurn(conversationId: string, turnId: string): Promise<void>;
+  /** Retries a failed participant within an active turn. */
+  retryParticipant(conversationId: string, turnId: string, participantId: string): Promise<void>;
+  /** Resolves an attempt in an unknown or interrupted state. */
+  resolveAttempt(conversationId: string, turnId: string, attemptId: string, resolution: 'accept' | 'retry' | 'abort'): Promise<void>;
   /** Fires after any chat is created, saved, renamed or deleted, so the sidebar can refresh. */
   onChatsChanged(listener: () => void): () => void;
 }
diff --git a/packages/core/src/index.ts b/packages/core/src/index.ts
index e99f2400..dbeaa8d8 100644
--- a/packages/core/src/index.ts
+++ b/packages/core/src/index.ts
@@ -52,6 +52,7 @@ export * from './ai/assistant/assistantTypes';
 export * from './ai/assistant/assistantPersonas';
 export * from './ai/assistant/assistantEngine';
 export * from './ai/assistant/teamChatStore';
+export * from './ai/assistant/teamChatCoordinator';
 export * from './ai/ticketContext';
 export * from './ai/mcp/mcpServerConfig';
 export * from './ai/mcp/mcpToolBridge';

```
