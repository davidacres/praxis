import * as assert from 'assert';
import type { AgentEventSummary, AgentSessionRecord, AgentTaskDefinition } from '../ai/agentTypes';
import { CopilotAgentService } from '../ai/copilotAgentService';

class FakeSessionManager {
  public readonly records = new Map<string, AgentSessionRecord>();
  public readonly stateChanges: Array<{ issueKey: string; state: string }> = [];
  public readonly appendedEvents: Array<{ issueKey: string; events: AgentEventSummary[] }> = [];

  public getAgentSession(issueKey: string): AgentSessionRecord | undefined {
    return this.records.get(issueKey);
  }

  public updateAgentState(issueKey: string, state: AgentSessionRecord['state']): void {
    this.stateChanges.push({ issueKey, state });
    const record = this.records.get(issueKey);
    if (record) {
      record.state = state;
    }
  }

  public appendAgentEvents(
    issueKey: string,
    events: AgentEventSummary[],
    incrementSteps?: number
  ): void {
    this.appendedEvents.push({ issueKey, events });
    const record = this.records.get(issueKey);
    if (record) {
      record.events.push(...events);
      if (incrementSteps) {
        record.stepCount += incrementSteps;
      }
    }
  }

  public updateAgentOutput(): void {
    // Not needed for these tests.
  }

  public updateSessionStatus(): void {
    // Not needed for these tests.
  }
}

function createRecord(issueKey: string, state: AgentSessionRecord['state'] = 'planning'): AgentSessionRecord {
  const taskDefinition: AgentTaskDefinition = {
    goal: 'Test task',
    scope: 'src/',
    definitionOfDone: 'done'
  };
  return {
    issueKey,
    sessionId: `${issueKey}-session`,
    state,
    taskDefinition,
    events: [],
    stepCount: 0,
    startedAt: new Date().toISOString()
  };
}

function createActiveTask(issueKey: string) {
  return {
    issueKey,
    client: {
      async stop(): Promise<void> {}
    },
    session: {
      sessionId: `${issueKey}-session`,
      async send(): Promise<void> {},
      async sendAndWait(): Promise<undefined> { return undefined; },
      on(): () => void {
        return () => {};
      },
      async abort(): Promise<void> {},
      async disconnect(): Promise<void> {}
    },
    unsubscribes: [] as Array<() => void>,
    pendingPermissions: [] as Array<{
      description: string;
      kind: string;
      detail?: string;
      resolve: (
        result: 'allow_once' | 'allow_always' | 'deny',
        options?: { silent?: boolean }
      ) => void;
    }>,
    allowPermissionsForTask: false,
    messageBuffers: new Map<string, string>(),
    reasoningBuffers: new Map<string, string>(),
    toolNames: new Map<string, string>()
  };
}

suite('CopilotAgentService', () => {
  test('cleanup while awaiting permission does not revert session back to executing', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-1';
    sessionManager.records.set(issueKey, createRecord(issueKey, 'planning'));

    const logLines: string[] = [];
    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(message: string): void {
        logLines.push(message);
      }
    });

    const activeTask = createActiveTask(issueKey);
    (service as any).activeTasks.set(issueKey, activeTask);

    const hooks = (service as any).createInteractiveSessionHooks(issueKey);
    const permissionPromise = hooks.onPermissionRequest({ kind: 'write' });

    await (service as any).cleanupTask(issueKey);
    const permissionResult = await permissionPromise;

    assert.deepStrictEqual(
      sessionManager.stateChanges.map(change => change.state),
      ['awaiting_approval']
    );
    assert.strictEqual(permissionResult.kind, 'denied-interactively-by-user');
    assert.ok(logLines.some(line => line.includes('permission_requested')));
    assert.strictEqual((service as any).activeTasks.has(issueKey), false);
  });

  test('session shutdown marks the task as failed and cleans it up', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-2';
    sessionManager.records.set(issueKey, createRecord(issueKey, 'executing'));

    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(): void {}
    });

    (service as any).activeTasks.set(issueKey, createActiveTask(issueKey));

    (service as any).handleSessionEvent(
      issueKey,
      {
        type: 'session.shutdown',
        data: {
          shutdownType: 'error',
          errorReason: 'runtime crashed'
        }
      },
      50
    );

    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepStrictEqual(
      sessionManager.stateChanges.map(change => change.state),
      ['failed']
    );
    assert.ok(
      sessionManager.appendedEvents.some(({ events }) =>
        events.some(event => event.type === 'error' && event.summary.includes('runtime crashed'))
      )
    );
    assert.strictEqual((service as any).activeTasks.has(issueKey), false);
  });

  test('allow_always resolves all queued permission requests and enables auto-approval', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-3';
    sessionManager.records.set(issueKey, createRecord(issueKey, 'planning'));

    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(): void {}
    });

    const activeTask = createActiveTask(issueKey);
    (service as any).activeTasks.set(issueKey, activeTask);

    const hooks = (service as any).createInteractiveSessionHooks(issueKey);
    const firstPermission = hooks.onPermissionRequest({ kind: 'read', fileName: 'a.md' });
    const secondPermission = hooks.onPermissionRequest({ kind: 'read', fileName: 'b.md' });
    const thirdPermission = hooks.onPermissionRequest({ kind: 'read', fileName: 'c.md' });

    assert.strictEqual(activeTask.pendingPermissions.length, 3);

    service.respondToPermission(issueKey, 'allow_always');

    const results = await Promise.all([firstPermission, secondPermission, thirdPermission]);
    assert.deepStrictEqual(results.map(result => result.kind), ['approved', 'approved', 'approved']);
    assert.strictEqual(activeTask.pendingPermissions.length, 0);
    assert.strictEqual(activeTask.allowPermissionsForTask, true);
    assert.strictEqual(
      sessionManager.stateChanges[sessionManager.stateChanges.length - 1]?.state,
      'executing'
    );

    const autoApproved = await hooks.onPermissionRequest({ kind: 'read', fileName: 'd.md' });
    assert.strictEqual(autoApproved.kind, 'approved');
    assert.strictEqual(activeTask.pendingPermissions.length, 0);
  });

  test('pauseTask marks the session paused and removes the live task', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-4';
    sessionManager.records.set(issueKey, createRecord(issueKey, 'executing'));

    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(): void {}
    });

    (service as any).activeTasks.set(issueKey, createActiveTask(issueKey));

    await service.pauseTask(issueKey, 'Session paused for shutdown.');

    assert.deepStrictEqual(
      sessionManager.stateChanges.map(change => change.state),
      ['paused']
    );
    assert.ok(
      sessionManager.appendedEvents.some(({ events }) =>
        events.some(event => event.type === 'info' && event.summary.includes('paused'))
      )
    );
    assert.strictEqual(service.hasActiveTask(issueKey), false);
  });

  test('abortTask is idempotent when multiple callers stop the same session', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-5';
    sessionManager.records.set(issueKey, createRecord(issueKey, 'executing'));

    let abortCallCount = 0;
    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(): void {}
    });

    const activeTask = createActiveTask(issueKey);
    activeTask.session.abort = async (): Promise<void> => {
      abortCallCount += 1;
      await new Promise(resolve => setTimeout(resolve, 5));
    };
    (service as any).activeTasks.set(issueKey, activeTask);

    await Promise.all([service.abortTask(issueKey), service.abortTask(issueKey)]);

    assert.strictEqual(abortCallCount, 1);
    assert.deepStrictEqual(
      sessionManager.stateChanges.map(change => change.state),
      ['aborted']
    );
    assert.strictEqual(
      sessionManager.appendedEvents.flatMap(({ events }) => events).filter(event => event.type === 'aborted').length,
      1
    );
    assert.strictEqual(service.hasActiveTask(issueKey), false);
  });

  test('step limit failure is recorded once and not reported as a user abort', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-6';
    const record = createRecord(issueKey, 'executing');
    record.stepCount = 49;
    sessionManager.records.set(issueKey, record);

    let abortCallCount = 0;
    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(): void {}
    });

    const activeTask = createActiveTask(issueKey);
    activeTask.session.abort = async (): Promise<void> => {
      abortCallCount += 1;
    };
    (service as any).activeTasks.set(issueKey, activeTask);

    (service as any).handleSessionEvent(
      issueKey,
      {
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'tool-1',
          success: true,
          result: { content: 'ok' }
        }
      },
      50
    );

    await new Promise(resolve => setTimeout(resolve, 0));

    assert.strictEqual(abortCallCount, 1);
    assert.deepStrictEqual(
      sessionManager.stateChanges.map(change => change.state),
      ['failed']
    );
    const flatEvents = sessionManager.appendedEvents.flatMap(({ events }) => events);
    assert.ok(
      flatEvents.some(
        event =>
          event.type === 'error' &&
          event.summary.includes('step limit (50)')
      )
    );
    assert.strictEqual(flatEvents.filter(event => event.type === 'aborted').length, 0);
    assert.strictEqual(service.hasActiveTask(issueKey), false);
  });
});
