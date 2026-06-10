import * as assert from 'node:assert';
import type { AgentEventSummary, AgentSessionRecord, AgentTaskDefinition } from '../ai/agentTypes';
import { AGENT_DEFAULTS } from '../ai/agentTypes';
import {
  buildMsiVersionExample,
  buildSystemPrompt,
  buildWorktreeName,
  CopilotAgentService
} from '../ai/copilotAgentService';

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
    toolNames: new Map<string, string>(),
    maxSteps: AGENT_DEFAULTS.maxSteps as number
  };
}

suite('CopilotAgentService', () => {
  test('buildWorktreeName prefixes the issue key and normalizes the suffix', () => {
    const worktreeName = buildWorktreeName({
      key: 'KAMAI-39',
      summary: 'KAMAI-39 Update some stuff',
      branch: 'feature/update-some-stuff'
    } as never);

    assert.strictEqual(worktreeName, 'KAMAI-39-update-some-stuff');
  });

  test('buildMsiVersionExample appends issue key and build identifier', () => {
    assert.strictEqual(
      buildMsiVersionExample('TWT-999'),
      '1.0.0.1-TWT-999-buildx'
    );
  });

  test('buildSystemPrompt includes ticket-based worktree and MSI naming rules', () => {
    const taskDefinition: AgentTaskDefinition = {
      goal: 'Publish a fix',
      scope: 'repo',
      definitionOfDone: 'MSI published',
      workflow: {
        id: 'add-edit-dotnet-web-api',
        name: 'Add/Edit .NET Web API Workflow',
        description: 'Runs implementation, review, security, and test phases.',
        instructionsPath: '.github/skills/add-edit-dotnet-web-api/SKILL.md',
        link: 'https://example.test/workflows/add-edit-dotnet-web-api'
      }
    };

    const prompt = buildSystemPrompt(taskDefinition, {
      key: 'TWT-999',
      summary: 'Ship updated installer',
      status: 'Ready for Development',
      issueType: 'Task'
    } as never);

    assert.ok(prompt.includes('its name MUST start with TWT-999'));
    assert.ok(prompt.includes('Use a worktree name like: TWT-999-ship-updated-installer'));
    assert.ok(prompt.includes('Return that same <build-id> in DELIVERY_RESULT.buildIdentifier'));
    assert.ok(prompt.includes('Use an MSI version like: 1.0.0.1-TWT-999-buildx'));
    assert.ok(prompt.includes('## Assigned Workflow Pack'));
    assert.ok(prompt.includes('.github/skills/add-edit-dotnet-web-api/SKILL.md'));
    assert.ok(prompt.includes('https://example.test/workflows/add-edit-dotnet-web-api'));
  });

  test('permission requests are always auto-approved without prompting', async () => {
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
    const permissionResult = await hooks.onPermissionRequest({
      kind: 'write',
      fileName: 'src/notes.md'
    });

    assert.strictEqual(permissionResult.kind, 'approved');
    assert.strictEqual(activeTask.pendingPermissions.length, 0);
    assert.deepStrictEqual(sessionManager.stateChanges, []);
    assert.ok(
      sessionManager.appendedEvents.some(({ events }) =>
        events.some(
          event =>
            event.type === 'permission_completed' &&
            event.summary.includes('auto-approved by default policy')
        )
      )
    );
    assert.ok(logLines.some(line => line.includes('permission_completed')));
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

  test('allow_always is a no-op because every request is auto-approved on arrival', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-3';
    sessionManager.records.set(issueKey, createRecord(issueKey, 'planning'));

    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(): void {}
    });

    const activeTask = createActiveTask(issueKey);
    (service as any).activeTasks.set(issueKey, activeTask);

    const hooks = (service as any).createInteractiveSessionHooks(issueKey);
    const results = await Promise.all([
      hooks.onPermissionRequest({ kind: 'write', fileName: 'a.md' }),
      hooks.onPermissionRequest({ kind: 'write', fileName: 'b.md' }),
      hooks.onPermissionRequest({ kind: 'shell', fullCommandText: 'git push origin HEAD' })
    ]);

    assert.deepStrictEqual(results.map(result => result.kind), ['approved', 'approved', 'approved']);
    assert.strictEqual(activeTask.pendingPermissions.length, 0);
    assert.deepStrictEqual(sessionManager.stateChanges, []);

    // respondToPermission is a user-driven escape hatch; with no pending
    // requests it must be a safe no-op.
    service.respondToPermission(issueKey, 'allow_always');
    assert.strictEqual(activeTask.pendingPermissions.length, 0);
  });

  test('read permissions are silently auto-approved', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-3A-READ';
    sessionManager.records.set(issueKey, createRecord(issueKey, 'planning'));

    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(): void {}
    });

    const activeTask = createActiveTask(issueKey);
    (service as any).activeTasks.set(issueKey, activeTask);

    const hooks = (service as any).createInteractiveSessionHooks(issueKey);
    const result = await hooks.onPermissionRequest({
      kind: 'read',
      fileName: 'src/extension.ts'
    });

    assert.strictEqual(result.kind, 'approved');
    assert.strictEqual(activeTask.pendingPermissions.length, 0);
    assert.deepStrictEqual(sessionManager.stateChanges, []);
    assert.ok(
      sessionManager.appendedEvents.some(({ events }) =>
        events.some(
          event =>
            event.type === 'permission_completed' &&
            event.summary.includes('Permission requested: read src/extension.ts')
        )
      )
    );
  });

  test('safe shell version probes are silently auto-approved', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-3A';
    sessionManager.records.set(issueKey, createRecord(issueKey, 'planning'));

    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(): void {}
    });

    const activeTask = createActiveTask(issueKey);
    (service as any).activeTasks.set(issueKey, activeTask);

    const hooks = (service as any).createInteractiveSessionHooks(issueKey);
    const result = await hooks.onPermissionRequest({
      kind: 'shell',
      fullCommandText: String.raw`cd C:\dev\ticket-manager-worktrees\KAMAI-42 && dotnet --version 2>&1`
    });

    assert.strictEqual(result.kind, 'approved');
    assert.strictEqual(activeTask.pendingPermissions.length, 0);
    assert.deepStrictEqual(sessionManager.stateChanges, []);
    assert.ok(
      sessionManager.appendedEvents.some(({ events }) =>
        events.some(
          event =>
            event.type === 'permission_completed' &&
            event.summary.includes('auto-approved by default policy')
        )
      )
    );
  });

  test('shell build commands are silently auto-approved', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-3B';
    sessionManager.records.set(issueKey, createRecord(issueKey, 'planning'));

    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(): void {}
    });

    const activeTask = createActiveTask(issueKey);
    (service as any).activeTasks.set(issueKey, activeTask);

    const hooks = (service as any).createInteractiveSessionHooks(issueKey);
    const result = await hooks.onPermissionRequest({
      kind: 'shell',
      fullCommandText: String.raw`cd C:\dev\ticket-manager-worktrees\KAMAI-42 && dotnet build`
    });

    assert.strictEqual(result.kind, 'approved');
    assert.strictEqual(activeTask.pendingPermissions.length, 0);
    assert.deepStrictEqual(sessionManager.stateChanges, []);
  });

  test('read-only git inspection commands are silently auto-approved', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-3B-GIT';
    sessionManager.records.set(issueKey, createRecord(issueKey, 'planning'));

    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(): void {}
    });

    const activeTask = createActiveTask(issueKey);
    (service as any).activeTasks.set(issueKey, activeTask);

    const hooks = (service as any).createInteractiveSessionHooks(issueKey);
    const result = await hooks.onPermissionRequest({
      kind: 'shell',
      fullCommandText: String.raw`cd C:\dev\ticket-manager-worktrees\KAMAI-43-system-configurator-test-ticket2055 && git --no-pager status && git --no-pager branch`
    });

    assert.strictEqual(result.kind, 'approved');
    assert.strictEqual(activeTask.pendingPermissions.length, 0);
    assert.deepStrictEqual(sessionManager.stateChanges, []);
  });

  test('non-build shell commands are now also auto-approved under the default-allow policy', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-3C';
    sessionManager.records.set(issueKey, createRecord(issueKey, 'planning'));

    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(): void {}
    });

    const activeTask = createActiveTask(issueKey);
    (service as any).activeTasks.set(issueKey, activeTask);

    const hooks = (service as any).createInteractiveSessionHooks(issueKey);
    const result = await hooks.onPermissionRequest({
      kind: 'shell',
      fullCommandText: String.raw`cd C:\dev\ticket-manager-worktrees\KAMAI-42 && git push origin HEAD`
    });

    assert.strictEqual(result.kind, 'approved');
    assert.strictEqual(activeTask.pendingPermissions.length, 0);
    assert.deepStrictEqual(sessionManager.stateChanges, []);
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

  test('step limit extension runs in autopilot mode without aborting the session', async () => {
    const sessionManager = new FakeSessionManager();
    const issueKey = 'TM-6';
    const record = createRecord(issueKey, 'executing');
    record.stepCount = 50;
    sessionManager.records.set(issueKey, record);

    let abortCallCount = 0;
    const service = new CopilotAgentService(sessionManager as never, {
      appendLine(): void {}
    });

    const activeTask = createActiveTask(issueKey);
    activeTask.maxSteps = 50;
    activeTask.session.abort = async (): Promise<void> => {
      abortCallCount += 1;
    };
    (service as any).activeTasks.set(issueKey, activeTask);

    // Directly invoke the live autopilot step-limit path.
    await (service as any).promptForStepLimitExtension(issueKey);

    // Autopilot mode: the step limit is removed transparently, the session is
    // never aborted, and no terminal state change is recorded.
    assert.strictEqual(abortCallCount, 0);
    assert.deepStrictEqual(
      sessionManager.stateChanges.map(change => change.state),
      []
    );

    const flatEvents = sessionManager.appendedEvents.flatMap(({ events }) => events);
    assert.ok(
      flatEvents.some(
        event => event.type === 'info' && event.summary.includes('Step limit removed automatically')
      ),
      'Should record that the step limit was removed automatically'
    );

    // The cap is lifted and the task remains active.
    assert.strictEqual(activeTask.maxSteps, Number.MAX_SAFE_INTEGER);
    assert.strictEqual(service.hasActiveTask(issueKey), true);
  });
});
