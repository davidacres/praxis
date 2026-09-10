import assert from 'node:assert/strict';
import test from 'node:test';
import { MOBILE_PROTOCOL_VERSION, type MobileCaller, type MobileCommand, type MobileReadRequest } from '@praxis/core';
import {
  createMobileHostExecutionHandlers,
  createMobileHostReads,
  mobileActorFor,
  type MobileHostServiceDeps,
} from './mobileHostServices';

const caller: MobileCaller = { deviceId: 'phone-1', subject: 'dave', capabilities: ['view', 'execute', 'approve'] };
const deviceOnly: MobileCaller = { deviceId: 'phone-1', capabilities: ['view', 'execute', 'approve'] };

interface Recorder {
  calls: Array<[string, ...unknown[]]>;
  deps: MobileHostServiceDeps;
}

function recorder(overrides: Partial<MobileHostServiceDeps> = {}): Recorder {
  const calls: Array<[string, ...unknown[]]> = [];
  const note = (name: string, ...args: unknown[]): void => {
    calls.push([name, ...args]);
  };
  const deps: MobileHostServiceDeps = {
    hostId: 'host-mac',
    hostName: () => 'Dave Mac',
    hostOnline: () => true,
    listProjects: async () => {
      note('listProjects');
      return [{ projectId: 'p1', name: 'Praxis' }];
    },
    getProject: async id => {
      note('getProject', id);
      return id === 'p1' ? { projectId: 'p1', name: 'Praxis', workflow: 'governed-delivery' } : undefined;
    },
    listWork: async projectId => {
      note('listWork', projectId);
      return [{ workId: 'W-1', title: 'x', status: 'idle' }];
    },
    getSession: async id => {
      note('getSession', id);
      return id === 's1' ? { sessionId: 's1', workId: 'W-1', title: 'x', status: 'idle', transcript: [] } : undefined;
    },
    getRun: async id => {
      note('getRun', id);
      return id === 'r1' ? { runId: 'r1', status: 'awaiting-approval' } : undefined;
    },
    listRunChanges: async runId => {
      note('listRunChanges', runId);
      return { runId, files: [] };
    },
    listAttention: async projectId => {
      note('listAttention', projectId);
      return [];
    },
    startRun: async input => {
      note('startRun', input);
      return { runId: 'r-new' };
    },
    cancelRun: async (runId, reason, actor) => {
      note('cancelRun', runId, reason, actor);
      return { runId };
    },
    retryStage: async (runId, nodeId, actor) => {
      note('retryStage', runId, nodeId, actor);
      return { runId };
    },
    approveRun: async (runId, actor, note2) => {
      note('approveRun', runId, actor, note2);
      return { runId };
    },
    continueSession: async (sessionId, message, actor) => {
      note('continueSession', sessionId, message, actor);
      return { sessionId };
    },
    respondToPermission: async (requestId, decision, actor) => {
      note('respondToPermission', requestId, decision, actor);
      return { requestId };
    },
    ...overrides,
  };
  return { calls, deps };
}

function read(operation: MobileReadRequest['operation'], target: MobileReadRequest['target']): MobileReadRequest {
  return { protocolVersion: MOBILE_PROTOCOL_VERSION, requestId: 'req-1', caller, target, operation };
}

function command(operation: MobileCommand['operation'], target: MobileCommand['target'], payload: unknown, who: MobileCaller = caller): MobileCommand {
  return { protocolVersion: MOBILE_PROTOCOL_VERSION, commandId: 'cmd-abc1234', issuedAt: '2026-09-10T09:00:00.000Z', caller: who, target, operation, payload };
}

test('actor is the verified subject, falling back to the paired device', () => {
  assert.equal(mobileActorFor(caller), 'dave');
  assert.equal(mobileActorFor(deviceOnly), 'phone-1');
});

test('reads route to the matching dependency and pass through scope', async () => {
  const { calls, deps } = recorder();
  const reads = createMobileHostReads(deps);

  assert.deepEqual(await reads['hosts.list'](read('hosts.list', { hostId: 'host-mac' })), [
    { hostId: 'host-mac', hostName: 'Dave Mac', online: true },
  ]);
  await reads['projects.snapshot'](read('projects.snapshot', { hostId: 'host-mac', projectId: 'p1' }));
  await reads['work.list'](read('work.list', { hostId: 'host-mac', projectId: 'p1' }));
  await reads['attention.list'](read('attention.list', { hostId: 'host-mac', projectId: 'p1' }));
  await reads['changes.get'](read('changes.get', { hostId: 'host-mac', runId: 'r1' }));

  assert.deepEqual(calls.filter(c => c[0] !== 'getProject').map(c => c[0]), ['listWork', 'listAttention', 'listRunChanges']);
  assert.deepEqual(calls.find(c => c[0] === 'listWork'), ['listWork', 'p1']);
});

test('projects.snapshot returns the whole list when no project is targeted', async () => {
  const { deps } = recorder();
  const reads = createMobileHostReads(deps);
  assert.deepEqual(await reads['projects.snapshot'](read('projects.snapshot', { hostId: 'host-mac' })), {
    projects: [{ projectId: 'p1', name: 'Praxis' }],
  });
});

test('reads fail closed when a required identifier is missing', async () => {
  const { deps } = recorder();
  const reads = createMobileHostReads(deps);
  await assert.rejects(reads['work.list'](read('work.list', { hostId: 'host-mac' })), /requires target\.projectId/);
  await assert.rejects(reads['sessions.get'](read('sessions.get', { hostId: 'host-mac' })), /requires target\.sessionId/);
});

test('a not-found run or session is an error, not an empty result', async () => {
  const { deps } = recorder();
  const reads = createMobileHostReads(deps);
  await assert.rejects(reads['workflowRuns.get'](read('workflowRuns.get', { hostId: 'host-mac', runId: 'missing' })), /was not found/);
  await assert.rejects(reads['sessions.get'](read('sessions.get', { hostId: 'host-mac', sessionId: 'missing' })), /was not found/);
});

test('commands extract payload fields and carry the verified actor', async () => {
  const { calls, deps } = recorder();
  const handlers = createMobileHostExecutionHandlers(deps);

  await handlers['sessions.continue'](command('sessions.continue', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }, { message: '  ship it  ' }));
  await handlers['workflowGates.approve'](command('workflowGates.approve', { hostId: 'host-mac', projectId: 'p1', runId: 'r1' }, { note: 'looks good' }));
  await handlers['workflowRuns.cancel'](command('workflowRuns.cancel', { hostId: 'host-mac', projectId: 'p1', runId: 'r1' }, {}, deviceOnly));
  await handlers['workflowRuns.retryStage'](command('workflowRuns.retryStage', { hostId: 'host-mac', projectId: 'p1', runId: 'r1' }, { nodeId: 'qa' }));

  assert.deepEqual(calls.find(c => c[0] === 'continueSession'), ['continueSession', 's1', 'ship it', 'dave']);
  assert.deepEqual(calls.find(c => c[0] === 'approveRun'), ['approveRun', 'r1', 'dave', 'looks good']);
  assert.deepEqual(calls.find(c => c[0] === 'cancelRun'), ['cancelRun', 'r1', undefined, 'phone-1']);
  assert.deepEqual(calls.find(c => c[0] === 'retryStage'), ['retryStage', 'r1', 'qa', 'dave']);
});

test('commands reject a missing or malformed payload', async () => {
  const { deps } = recorder();
  const handlers = createMobileHostExecutionHandlers(deps);
  await assert.rejects(handlers['sessions.continue'](command('sessions.continue', { hostId: 'host-mac', projectId: 'p1', sessionId: 's1' }, { message: '   ' })), /non-empty payload\.message/);
  await assert.rejects(handlers['workflowRuns.start'](command('workflowRuns.start', { hostId: 'host-mac', projectId: 'p1' }, {})), /payload\.workflowId/);
  await assert.rejects(handlers['permissions.respond'](command('permissions.respond', { hostId: 'host-mac', projectId: 'p1', requestId: 'q1' }, { decision: 'maybe' })), /'allow' or 'deny'/);
  await assert.rejects(handlers['permissions.respond'](command('permissions.respond', { hostId: 'host-mac', projectId: 'p1' }, { decision: 'allow' })), /requires target\.requestId/);
});
