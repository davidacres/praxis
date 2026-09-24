import type { MobileCaller, MobileReadOperation, MobileReadRequest, MobileSessionSnapshot, MobileSessionSummary } from '@praxis/core';
import type { MobileAttentionItem } from '../../renderer/mobileAttention';
import { formatClock } from '../../renderer/mobileTime';
import type { MobileActivityEntry, MobileTranscriptMessage, MobileWorkItem } from './types';

/**
 * Pure shaping of what the desktop sends into what the screens show — kept
 * apart from the provider so the connection code reads as connection code.
 */

/** The desktop replaces this with the Noise-authenticated device identity. */
export const caller: MobileCaller = { deviceId: 'praxis-mobile', capabilities: ['view', 'execute', 'approve'] };

export function commandId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export function readRequest(operation: MobileReadOperation, target: MobileReadRequest['target'], params?: MobileReadRequest['params']): MobileReadRequest {
  return {
    protocolVersion: 1,
    requestId: commandId(operation),
    caller,
    target,
    operation,
    ...(params ? { params } : {}),
  };
}

export function workFromSession(session: MobileSessionSummary): MobileWorkItem {
  return {
    workId: session.sessionKey,
    title: session.title,
    status: session.lifecycle,
    sessionId: session.sessionId,
    mode: session.mode,
    ...(session.provider ? { provider: session.provider } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.runId ? { runId: session.runId } : {}),
  };
}

export function transcript(snapshot: MobileSessionSnapshot | undefined): MobileTranscriptMessage[] {
  if (!snapshot) return [];
  return snapshot.messages.map(message => ({
    id: message.id,
    author: message.role,
    text: message.text,
    at: formatClock(message.at),
    streaming: message.status === 'streaming',
    ...(message.gadgets?.length ? { gadgets: message.gadgets } : {}),
  }));
}

const LIFECYCLE_TEXT: Record<string, string> = {
  active: 'Working',
  'awaiting-input': 'Waiting for you',
  completed: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
  idle: 'Idle',
};

export function permissionItems(hostId: string, snapshot: MobileSessionSnapshot): MobileAttentionItem[] {
  if (!snapshot.projectId) return [];
  return snapshot.pendingPermissions.map(permission => ({
    id: `permission:${permission.requestId}`,
    kind: 'permission' as const,
    hostId,
    projectId: snapshot.projectId!,
    sessionId: snapshot.sessionId,
    requestId: permission.requestId,
    summary: permission.summary,
    ...(permission.detail ? { detail: permission.detail } : {}),
    createdAt: permission.createdAt,
    resolved: false,
  }));
}

/** The Activity screen: each chat's latest line, newest first. */
export function activityEntries(work: readonly MobileWorkItem[], snapshots: Readonly<Record<string, MobileSessionSnapshot>>): MobileActivityEntry[] {
  return work
    .filter(item => !item.draft)
    .map(item => {
      const snapshot = snapshots[item.sessionId];
      const last = snapshot?.messages[snapshot.messages.length - 1];
      const at = last?.at ?? snapshot?.completedAt ?? snapshot?.startedAt;
      const lastText = last ? last.text || (last.gadgets?.length ? `[${last.gadgets[0]!.gadget.kind}]` : '') : '';
      return {
        id: item.sessionId,
        at: at ?? '',
        workId: item.workId,
        title: item.title,
        text: `${LIFECYCLE_TEXT[item.status] ?? item.status}${last ? ` — ${last.role === 'user' ? 'You' : last.role === 'system' ? 'Desktop' : 'Agent'}: ${lastText.slice(0, 120)}` : ''}`,
      };
    })
    .filter(entry => entry.at)
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, 40)
    .map(entry => ({ ...entry, at: formatClock(entry.at) }));
}
