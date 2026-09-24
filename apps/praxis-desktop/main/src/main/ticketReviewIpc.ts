import { ipcMain } from 'electron';
import {
  getProviderDescriptor,
  providerNeedsApiKey,
  buildTicketReviewGoal,
  ticketReviewSessionKey,
  type AgentSessionRecord,
  type AiTicketReviewInput
} from '@praxis/core';
import { abortActiveTask, assertCanRunAgentSession, getAiSessionManager, hasActiveTask, resolveConnectionOptions } from './aiInstance';
import { trackerToolExtension } from './aiIpc';
import { launchAgentTask, prepareAgentLaunch } from './agentSessionLauncher';
import { getGadgetService } from './gadgetInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { getServiceForConnection } from './serviceRegistry';
import { forgetTicketReviewBaseline, recordTicketReviewBaseline } from './ticketReviewApply';

/**
 * Starts a ticket review as a real agent session.
 *
 * It is a session — read-only, recorded, visible in Sessions — rather than a
 * one-shot prompt because only a session has a scope for its gadgets to be
 * issued against and a conversation for the user's answers to travel back on.
 * The session is stored under `ticketReviewSessionKey(issue)`, not the ticket's
 * own key, so reviewing a ticket never replaces its implementation session.
 */
async function startTicketReview(input: AiTicketReviewInput): Promise<AgentSessionRecord> {
  const sessionManager = getAiSessionManager();
  const settings = getSettingsBackend().read();
  const provider = input.provider ?? settings.ai.activeProvider;
  const descriptor = getProviderDescriptor(provider);

  if (settings.ai.providers[provider]?.enabled === false) {
    throw new Error(`${descriptor.label} is turned off. Enable it under Settings → AI Provider.`);
  }
  if (descriptor.kind === 'api' && !(await resolveConnectionOptions(provider)).apiKey && providerNeedsApiKey(provider)) {
    throw new Error(`No ${descriptor.label} API key configured. Add one under Settings → AI Provider.`);
  }
  assertCanRunAgentSession(provider);

  const service = await getServiceForConnection(input.connectionId);
  const issue = await service.getIssue(input.issueKey);
  const sessionKey = ticketReviewSessionKey(issue.key);

  // A re-run replaces the previous review. Its gadgets belong to a session that
  // is about to stop existing, so they go with it rather than lingering as
  // answerable-looking controls for a conversation nobody is having.
  const previous = sessionManager.getAgentSession(sessionKey);
  if (previous) {
    if (hasActiveTask(sessionKey)) await abortActiveTask(sessionKey);
    getGadgetService().clearSession(previous.sessionId);
    forgetTicketReviewBaseline(previous.sessionId);
  }

  const prepared = await prepareAgentLaunch({ provider });
  await launchAgentTask(prepared, {
    issue: { ...issue, key: sessionKey },
    taskDefinition: {
      kind: 'ticket-review',
      sessionMode: 'review',
      goal: buildTicketReviewGoal(issue),
      scope: 'Read-only review of this ticket and any workspace context it references.',
      definitionOfDone: 'A verdict is presented and each actionable finding is offered as a decision.',
      nonGoals: ['Do not edit files or write to the tracker.'],
      completionContract: 'Stop after presenting the review and wait for the user to answer the decisions.'
    },
    provider,
    model: input.model,
    workingDirectory:
      settings.ai.workingDirectory.trim() || process.env.PRAXIS_AI_WORKING_DIR?.trim() || undefined,
    toolMode: 'read-only',
    ...(prepared.plan.state === 'gateway' ? { toolExtension: trackerToolExtension(service, 'read-only') } : {})
  });

  const record = sessionManager.getAgentSession(sessionKey);
  if (!record) throw new Error(`The review of ${issue.key} did not start.`);

  if (input.connectionId) sessionManager.updateAgentRuntime(sessionKey, { connectionId: input.connectionId });
  sessionManager.renameAgentSession(sessionKey, `Review ${issue.key} — ${issue.summary}`);
  recordTicketReviewBaseline(record.sessionId, issue);

  return sessionManager.getAgentSession(sessionKey) ?? record;
}

export function registerTicketReviewIpc(): void {
  ipcMain.handle('ai:startTicketReview', async (_event, input: AiTicketReviewInput) => {
    if (!input?.issueKey?.trim()) throw new Error('A ticket review needs an issue key.');
    return startTicketReview(input);
  });

  ipcMain.handle('ai:getTicketReview', async (_event, issueKey: string) =>
    getAiSessionManager().getAgentSession(ticketReviewSessionKey(issueKey))
  );
}
