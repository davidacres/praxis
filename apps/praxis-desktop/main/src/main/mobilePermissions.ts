import type { AgentSessionRecord, PermissionDecision } from '@praxis/core';

export interface MobilePermissionRequest {
  requestId: string;
  sessionId: string;
  sessionKey: string;
  projectId?: string;
  summary: string;
  detail?: string;
  createdAt: string;
}

export function pendingMobilePermissions(records: Iterable<AgentSessionRecord>): MobilePermissionRequest[] {
  const pending: MobilePermissionRequest[] = [];
  for (const record of records) {
    const sessionPending: MobilePermissionRequest[] = [];
    record.events.forEach((event, index) => {
      if (event.type === 'permission_requested') {
        sessionPending.push({
          requestId: `${record.sessionId}:permission:${index}`,
          sessionId: record.sessionId,
          sessionKey: record.issueKey,
          ...(record.projectId ? { projectId: record.projectId } : {}),
          summary: event.summary,
          ...(event.detail ? { detail: event.detail } : {}),
          createdAt: event.timestamp,
        });
      } else if (event.type === 'permission_completed') {
        sessionPending.shift();
      }
    });
    pending.push(...sessionPending);
  }
  return pending;
}

export function respondToMobilePermission(input: {
  records: Iterable<AgentSessionRecord>;
  requestId: string;
  projectId: string;
  decision: 'allow' | 'deny';
  hasActiveTask(sessionKey: string): boolean;
  respond(sessionKey: string, decision: PermissionDecision): void;
}): { requestId: string; decision: 'allow' | 'deny'; sessionId: string } {
  const pending = pendingMobilePermissions(input.records);
  const request = pending.find(candidate => candidate.requestId === input.requestId);
  if (!request) throw new Error('That permission request is no longer pending.');
  // The hosts answer a session's requests oldest first, whatever id is named, so
  // answering a later one would really decide the earlier one.
  if (pending.find(candidate => candidate.sessionId === request.sessionId)?.requestId !== request.requestId) {
    throw new Error('This session has an earlier permission request waiting. Answer that one first.');
  }
  if (request.projectId !== input.projectId) throw new Error(`That permission request is not in project ${input.projectId}.`);
  if (!input.hasActiveTask(request.sessionKey)) throw new Error('The session for that permission request is no longer active.');
  input.respond(request.sessionKey, input.decision === 'allow' ? 'allow_once' : 'deny');
  return { requestId: request.requestId, decision: input.decision, sessionId: request.sessionId };
}
