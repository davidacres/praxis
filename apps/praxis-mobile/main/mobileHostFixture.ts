/**
 * A deterministic in-process host that satisfies the real core mobile-host
 * contracts (`MobileHostApplication`, `handleMobileRead`, `handleMobileCommand`,
 * `InMemoryMobileCommandLedger`). It stands in for the desktop's session and
 * workflow managers so the pair -> connect -> continue -> approve -> reconnect
 * journey can run with no Electron, no network beyond loopback, and no model.
 *
 * This is a development fixture. The real desktop binding (FX-BE-081/082) wires
 * these same contracts to `aiSessionManager` / `workflowOrchestrator` /
 * `workflowGates` instead of the in-memory state below.
 */
import {
  InMemoryMobileCommandLedger,
  MOBILE_PROTOCOL_VERSION,
  type MobileCommand,
  type MobileEventEnvelope,
  type MobileExecutionHandlers,
  type MobileHostApplication,
  type MobileHostReads,
} from '@praxis/core';

export const FIXTURE_HOST_ID = 'fixture-host';
export const FIXTURE_PROJECT_ID = 'fixture-project';

export interface FixtureSession {
  sessionId: string;
  workId: string;
  title: string;
  status: 'idle' | 'running';
  transcript: string[];
}

export interface FixtureRun {
  runId: string;
  workflowId: string;
  status: 'running' | 'awaiting-approval' | 'approved' | 'cancelled';
  stage: string;
  gate: 'pending' | 'passed';
}

export interface FixtureAttentionItem {
  id: string;
  kind: 'approval';
  runId: string;
  resolved: boolean;
}

export interface FixtureState {
  session: FixtureSession;
  run: FixtureRun;
  attention: FixtureAttentionItem[];
}

export interface MobileHostFixture {
  app: MobileHostApplication;
  ledger: InMemoryMobileCommandLedger;
  state: FixtureState;
  /** Every event the host has emitted so far, in order. */
  emitted(): readonly MobileEventEnvelope[];
}

export function createMobileHostFixture(now: () => string = () => new Date().toISOString()): MobileHostFixture {
  const ledger = new InMemoryMobileCommandLedger();
  const emitted: MobileEventEnvelope[] = [];
  let sequence = 0;

  const emit = (event: unknown, extra: Record<string, string> = {}): MobileEventEnvelope => {
    sequence += 1;
    const envelope: MobileEventEnvelope = {
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      eventId: `evt-${sequence}`,
      sequence,
      emittedAt: now(),
      target: { hostId: FIXTURE_HOST_ID, projectId: FIXTURE_PROJECT_ID, ...extra },
      event,
    };
    ledger.appendEvent(envelope);
    emitted.push(envelope);
    return envelope;
  };

  const state: FixtureState = {
    session: {
      sessionId: 'sess-1',
      workId: 'FIX-1',
      title: 'Wire the mobile listener into desktop startup',
      status: 'idle',
      transcript: ['Planned the change against index.ts.'],
    },
    run: { runId: 'run-1', workflowId: 'governed-delivery', status: 'running', stage: 'implement', gate: 'pending' },
    attention: [],
  };

  const reads: MobileHostReads = {
    'hosts.list': async () => [{ hostId: FIXTURE_HOST_ID, hostName: 'Fixture Praxis Host', online: true }],
    'projects.snapshot': async () => ({ projectId: FIXTURE_PROJECT_ID, name: 'Fixture', workflow: 'governed-delivery' }),
    'work.list': async () => [
      { workId: state.session.workId, title: state.session.title, status: state.session.status, sessionId: state.session.sessionId },
    ],
    'sessions.list': async () => [{
      sessionId: state.session.sessionId,
      sessionKey: state.session.workId,
      projectId: FIXTURE_PROJECT_ID,
      workId: state.session.workId,
      title: state.session.title,
      lifecycle: state.session.status === 'running' ? 'active' : 'idle',
      mode: 'chat',
      archived: false,
      startedAt: '2026-09-10T09:00:00.000Z',
    }],
    'sessions.get': async () => ({ ...state.session, transcript: [...state.session.transcript] }),
    'workflows.list': async () => [{ workflowId: state.run.workflowId, name: 'Governed delivery', trigger: 'manual' }],
    'workflowRuns.get': async () => ({ ...state.run }),
    'changes.get': async () => ({ runId: state.run.runId, files: [{ path: 'apps/praxis-desktop/main/src/main/index.ts', added: 14, removed: 0 }] }),
    'attention.list': async () => state.attention.filter(item => !item.resolved).map(item => ({ ...item })),
  };

  const commands: MobileExecutionHandlers = {
    'sessions.create': async () => ({ sessionId: state.session.sessionId, accepted: true }),
    'sessions.continue': async (command: MobileCommand) => {
      const message = String((command.payload as { message?: unknown } | undefined)?.message ?? '').trim();
      if (!message) throw new Error('sessions.continue requires a message.');
      state.session.status = 'running';
      state.session.transcript.push(message);
      emit({ kind: 'session.message', sessionId: state.session.sessionId, message }, { sessionId: state.session.sessionId });
      state.session.status = 'idle';
      emit({ kind: 'session.idle', sessionId: state.session.sessionId }, { sessionId: state.session.sessionId });
      return { sessionId: state.session.sessionId, accepted: true };
    },
    'sessions.cancel': async () => {
      state.session.status = 'idle';
      emit({ kind: 'session.stopped', sessionId: state.session.sessionId }, { sessionId: state.session.sessionId });
      return { sessionId: state.session.sessionId, stopped: true };
    },
    'workflowRuns.start': async () => {
      state.run.status = 'running';
      state.run.stage = 'implement';
      emit({ kind: 'run.started', runId: state.run.runId, stage: state.run.stage }, { runId: state.run.runId });
      return { runId: state.run.runId, status: state.run.status };
    },
    'workflowRuns.cancel': async () => {
      state.run.status = 'cancelled';
      emit({ kind: 'run.cancelled', runId: state.run.runId }, { runId: state.run.runId });
      return { runId: state.run.runId, status: state.run.status };
    },
    'workflowRuns.retryStage': async () => {
      emit({ kind: 'run.stageRetried', runId: state.run.runId, stage: state.run.stage }, { runId: state.run.runId });
      return { runId: state.run.runId, stage: state.run.stage };
    },
    'permissions.respond': async (command: MobileCommand) => {
      const decision = String((command.payload as { decision?: unknown } | undefined)?.decision ?? 'deny');
      emit({ kind: 'permission.resolved', requestId: command.target.requestId ?? 'unknown', decision });
      return { requestId: command.target.requestId, decision };
    },
    'workflowGates.approve': async () => {
      state.run.gate = 'passed';
      state.run.status = 'approved';
      for (const item of state.attention) if (item.runId === state.run.runId) item.resolved = true;
      emit({ kind: 'gate.approved', runId: state.run.runId, stage: state.run.stage }, { runId: state.run.runId });
      return { runId: state.run.runId, gate: state.run.gate, status: state.run.status };
    },
  };

  // Seed: the run has already reached its approval gate and raised attention.
  state.run.status = 'awaiting-approval';
  state.attention.push({ id: 'att-1', kind: 'approval', runId: state.run.runId, resolved: false });
  emit({ kind: 'run.awaitingApproval', runId: state.run.runId, stage: state.run.stage }, { runId: state.run.runId });

  const app: MobileHostApplication = {
    reads,
    commands,
    ledger,
    payloadDigest: (command: MobileCommand) => JSON.stringify(command.payload ?? null),
  };

  return { app, ledger, state, emitted: () => emitted };
}
