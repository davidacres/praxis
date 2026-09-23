import type {
  AgentSessionRecord,
  MobileAppearance,
  MobileCommandLedger,
  MobileHostEvent,
  MobileSessionEvent,
  MobileSessionLifecycle,
  MobileSessionMessage,
  MobilePendingPermission,
  MobileSessionSnapshot,
  MobileSessionSummary,
} from '@praxis/core';

const MAX_MOBILE_MESSAGES = 80;
const MAX_MOBILE_MESSAGE_CHARS = 8_000;
const MAX_MOBILE_REASONING_CHARS = 4_000;
const MAX_MOBILE_RESPONSE_CHARS = 12_000;

function boundedText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const marker = '\n\n[…content truncated for mobile…]\n\n';
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available * 0.6);
  const tail = available - head;
  return `${value.slice(0, head)}${marker}${value.slice(-tail)}`;
}

function lifecycleFor(record: AgentSessionRecord): MobileSessionLifecycle {
  switch (record.state) {
    case 'planning':
    case 'executing':
      return 'active';
    case 'awaiting_approval':
    case 'awaiting_input':
    case 'paused':
      return 'awaiting-input';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'aborted':
      return 'stopped';
    default:
      return 'idle';
  }
}

export function mobileSessionSummary(record: AgentSessionRecord): MobileSessionSummary {
  return {
    sessionId: record.sessionId,
    sessionKey: record.issueKey,
    ...(record.projectId ? { projectId: record.projectId } : {}),
    ...(record.issueKey ? { workId: record.issueKey } : {}),
    ...(record.workflowRunId ? { runId: record.workflowRunId } : {}),
    ...(record.parentSessionKey ? { parentSessionKey: record.parentSessionKey } : {}),
    title: record.title?.trim() || record.taskDefinition.goal.trim() || record.issueKey,
    lifecycle: lifecycleFor(record),
    ...(record.provider ? { provider: record.provider } : {}),
    ...(record.model ? { model: record.model } : {}),
    mode: record.mode ?? 'chat',
    archived: record.archived === true,
    startedAt: record.startedAt,
    ...(record.completedAt ? { completedAt: record.completedAt } : {}),
  };
}

function persistedMessages(record: AgentSessionRecord): MobileSessionMessage[] {
  const initialGoal = record.taskDefinition.goal.trim();
  const messages: MobileSessionMessage[] = initialGoal
    ? [{ id: `${record.sessionId}:initial`, role: 'user', text: initialGoal, at: record.startedAt, status: 'complete' }]
    : [];
  // A provider handover is recorded as a runtime event whose detail is the
  // handover brief, then sent to the new provider as a user turn. The brief
  // carries workspace paths and transcript excerpts, so the phone gets only
  // the event's one-line summary and never the brief itself.
  const handoverBriefs = new Set<string>();
  record.events.forEach((event, index) => {
    if (event.type === 'provider_handover' || event.type === 'model_change') {
      if (event.type === 'provider_handover' && event.detail?.trim()) handoverBriefs.add(event.detail.trim());
      messages.push({ id: `${record.sessionId}:event:${index}`, role: 'system', text: event.summary.trim(), at: event.timestamp, status: 'complete' });
      return;
    }
    const role = event.type === 'user_input_completed'
      ? 'user'
      : event.type === 'message'
        ? 'assistant'
        : event.type === 'error'
          ? 'system'
          : undefined;
    const text = (event.detail || event.summary).trim();
    if (!role || !text) return;
    if (role === 'user' && handoverBriefs.has(text)) return;
    if (role === 'user' && messages.some(message => message.role === 'user' && message.text === text)) return;
    messages.push({
      id: `${record.sessionId}:event:${index}`,
      role,
      text: boundedText(text, MAX_MOBILE_MESSAGE_CHARS),
      at: event.timestamp,
      status: event.type === 'error' ? 'failed' : 'complete',
      ...(event.reasoning ? { reasoning: boundedText(event.reasoning, MAX_MOBILE_REASONING_CHARS) } : {}),
      ...(event.modelId ? { model: event.modelId } : {}),
      ...(event.toolNames?.length ? { toolNames: event.toolNames } : {}),
    });
  });
  return messages.length > MAX_MOBILE_MESSAGES ? messages.slice(-MAX_MOBILE_MESSAGES) : messages;
}

export function mobileSessionSnapshot(record: AgentSessionRecord, sequence = record.events.length): MobileSessionSnapshot {
  const summary = mobileSessionSummary(record);
  const messages = persistedMessages(record);
  const active = summary.lifecycle === 'active' || summary.lifecycle === 'awaiting-input';
  const responseText = record.responseText?.trim();
  const last = messages[messages.length - 1];
  const pendingPermissions: MobilePendingPermission[] = [];
  record.events.forEach((event, index) => {
    if (event.type === 'permission_requested') {
      pendingPermissions.push({
        requestId: `${record.sessionId}:permission:${index}`,
        summary: event.summary,
        ...(event.detail ? { detail: event.detail } : {}),
        createdAt: event.timestamp,
      });
    } else if (event.type === 'permission_completed') {
      pendingPermissions.shift();
    }
  });
  if (active && responseText && !(last?.role === 'assistant' && last.text === responseText)) {
    messages.push({
      id: `${record.sessionId}:active`,
      role: 'assistant',
      text: boundedText(responseText, MAX_MOBILE_RESPONSE_CHARS),
      at: new Date().toISOString(),
      status: 'streaming',
      ...(record.reasoningText?.trim() ? { reasoning: boundedText(record.reasoningText.trim(), MAX_MOBILE_REASONING_CHARS) } : {}),
      ...(record.model ? { model: record.model } : {}),
    });
  }
  if (messages.length > MAX_MOBILE_MESSAGES) messages.splice(0, messages.length - MAX_MOBILE_MESSAGES);
  return {
    ...summary,
    sequence,
    messages,
    pendingPermissions,
    ...(active && responseText ? { responseText: boundedText(responseText, MAX_MOBILE_RESPONSE_CHARS) } : {}),
    ...(active && record.reasoningText?.trim() ? { reasoningText: boundedText(record.reasoningText.trim(), MAX_MOBILE_REASONING_CHARS) } : {}),
    ...(record.tokenUsage ? { tokenUsage: record.tokenUsage } : {}),
    ...(record.contextTokens !== undefined ? { contextTokens: record.contextTokens } : {}),
    ...(record.contextLimit !== undefined ? { contextLimit: record.contextLimit } : {}),
    ...(record.cost ? { cost: record.cost } : {}),
    canContinue: !active && !record.archived,
    canCancel: active,
  };
}

/**
 * Appends a session change to the mobile event log as a full snapshot stamped
 * with its own sequence — what `composeDesktopMobileHost` does on every
 * `onDidChangeAgentSession`, and what a phone replays after reconnecting.
 */
export function appendMobileSessionEvent(
  ledger: Pick<MobileCommandLedger, 'appendEvent' | 'latestSequence'>,
  hostId: string,
  record: AgentSessionRecord,
): number {
  const sequence = ledger.latestSequence() + 1;
  ledger.appendEvent<MobileSessionEvent>({
    protocolVersion: 1,
    eventId: `${record.sessionId}:${sequence}`,
    sequence,
    emittedAt: new Date().toISOString(),
    target: {
      hostId,
      ...(record.projectId ? { projectId: record.projectId } : {}),
      sessionId: record.sessionId,
      ...(record.workflowRunId ? { runId: record.workflowRunId } : {}),
    },
    event: { type: 'session.snapshot', snapshot: mobileSessionSnapshot(record, sequence) },
  });
  return sequence;
}

/** Appends a theme change: host-wide, so every paired phone gets it whatever projects it is granted. */
export function appendMobileAppearanceEvent(
  ledger: Pick<MobileCommandLedger, 'appendEvent' | 'latestSequence'>,
  hostId: string,
  appearance: MobileAppearance,
): number {
  const sequence = ledger.latestSequence() + 1;
  ledger.appendEvent<MobileHostEvent>({
    protocolVersion: 1,
    eventId: `appearance:${sequence}`,
    sequence,
    emittedAt: new Date().toISOString(),
    target: { hostId },
    event: { type: 'host.appearance', appearance },
  });
  return sequence;
}
