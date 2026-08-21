import * as assert from 'assert';
import type { AgentSessionRecord, AgentTaskDefinition, AgentTaskState } from '../ai/agentTypes';
import { AGENT_DEFAULTS } from '../ai/agentTypes';
import { AiSessionManager } from '../ai/aiSessionManager';

/**
 * Minimal vscode.Memento stub for unit testing AiSessionManager.
 */
class MemoryMemento {
  private store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.store.get(key) as T) ?? defaultValue;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  keys(): readonly string[] {
    return [...this.store.keys()];
  }
  setKeysForSync(): void { /* no-op */ }
}

suite('Agent Types & Defaults', () => {
  test('AGENT_DEFAULTS contains expected fields', () => {
    assert.strictEqual(typeof AGENT_DEFAULTS.maxSteps, 'number');
    assert.strictEqual(typeof AGENT_DEFAULTS.timeoutMs, 'number');
    assert.ok(AGENT_DEFAULTS.maxSteps > 0, 'maxSteps should be positive');
    assert.ok(AGENT_DEFAULTS.timeoutMs > 0, 'timeoutMs should be positive');
  });

  test('All valid AgentTaskStates are string literals', () => {
    const validStates: AgentTaskState[] = [
      'not_started', 'planning', 'awaiting_approval',
      'executing', 'awaiting_input', 'paused', 'completed', 'failed', 'aborted'
    ];
    assert.strictEqual(validStates.length, 9);
    validStates.forEach(s => assert.strictEqual(typeof s, 'string'));
  });
});

suite('AiSessionManager — Agent Sessions', () => {
  let manager: AiSessionManager;

  const taskDef: AgentTaskDefinition = {
    goal: 'Fix login bug',
    scope: 'src/auth/',
    definitionOfDone: 'Auth tests pass'
  };

  setup(() => {
    const memento = new MemoryMemento() as unknown as import('vscode').Memento;
    manager = new AiSessionManager(memento);
  });

  teardown(() => {
    manager.dispose();
  });

  test('createAgentSession creates and returns a new record', () => {
    const record = manager.createAgentSession('ISSUE-1', 'session-abc', taskDef);
    assert.strictEqual(record.issueKey, 'ISSUE-1');
    assert.strictEqual(record.sessionId, 'session-abc');
    assert.strictEqual(record.state, 'not_started');
    assert.strictEqual(record.stepCount, 0);
    assert.ok(record.startedAt);
    assert.deepStrictEqual(record.taskDefinition, taskDef);
    assert.deepStrictEqual(record.events, []);
  });

  test('createAgentSession stores the runtime provider when supplied', () => {
    const record = manager.createAgentSession(
      'ISSUE-GATEWAY',
      'session-gateway',
      taskDef,
      'vercel-gateway'
    );

    assert.strictEqual(record.provider, 'vercel-gateway');
    assert.strictEqual(manager.getAgentSession('ISSUE-GATEWAY')?.provider, 'vercel-gateway');
  });

  test('getAgentSession returns created session', () => {
    manager.createAgentSession('ISSUE-1', 'sess-1', taskDef);
    const fetched = manager.getAgentSession('ISSUE-1');
    assert.ok(fetched);
    assert.strictEqual(fetched!.sessionId, 'sess-1');
  });

  test('getAgentSession returns undefined for non-existent key', () => {
    assert.strictEqual(manager.getAgentSession('NOPE'), undefined);
  });

  test('getAllAgentSessions returns a snapshot', () => {
    manager.createAgentSession('A', 's1', taskDef);
    manager.createAgentSession('B', 's2', taskDef);
    const all = manager.getAllAgentSessions();
    assert.strictEqual(all.size, 2);
    assert.ok(all.has('A'));
    assert.ok(all.has('B'));
  });

  test('updateAgentState transitions state', () => {
    manager.createAgentSession('X', 's1', taskDef);
    manager.updateAgentState('X', 'planning');
    assert.strictEqual(manager.getAgentSession('X')!.state, 'planning');

    manager.updateAgentState('X', 'executing');
    assert.strictEqual(manager.getAgentSession('X')!.state, 'executing');
  });

  test('updateAgentState sets completedAt for terminal states', () => {
    manager.createAgentSession('X', 's1', taskDef);
    assert.strictEqual(manager.getAgentSession('X')!.completedAt, undefined);

    manager.updateAgentState('X', 'completed');
    assert.ok(manager.getAgentSession('X')!.completedAt);
  });

  test('updateAgentState sets completedAt for failed state', () => {
    manager.createAgentSession('X', 's1', taskDef);
    manager.updateAgentState('X', 'failed');
    assert.ok(manager.getAgentSession('X')!.completedAt);
  });

  test('updateAgentState sets completedAt for aborted state', () => {
    manager.createAgentSession('X', 's1', taskDef);
    manager.updateAgentState('X', 'aborted');
    assert.ok(manager.getAgentSession('X')!.completedAt);
  });

  test('updateAgentState clears completedAt when returning to an active state', () => {
    manager.createAgentSession('X', 's1', taskDef);
    manager.updateAgentState('X', 'completed');
    assert.ok(manager.getAgentSession('X')!.completedAt);

    manager.updateAgentState('X', 'executing');
    assert.strictEqual(manager.getAgentSession('X')!.completedAt, undefined);
  });

  test('updateAgentState keeps paused sessions active and not completed', () => {
    manager.createSession('AI-PAUSE', 'vercel-gateway', 'Vercel AI Gateway');
    manager.createAgentSession('AI-PAUSE', 's1', taskDef);

    manager.updateAgentState('AI-PAUSE', 'paused');

    assert.strictEqual(manager.getAgentSession('AI-PAUSE')!.state, 'paused');
    assert.strictEqual(manager.getAgentSession('AI-PAUSE')!.completedAt, undefined);
    assert.strictEqual(manager.getSession('AI-PAUSE')?.status, 'active');
  });

  test('updateAgentState is no-op for unknown key', () => {
    // Should not throw
    manager.updateAgentState('UNKNOWN', 'failed');
  });

  test('appendAgentEvents adds events and increments steps', () => {
    manager.createAgentSession('X', 's1', taskDef);

    manager.appendAgentEvents('X', [
      { timestamp: new Date().toISOString(), type: 'tool_start', summary: 'Running npm build' },
      { timestamp: new Date().toISOString(), type: 'tool_complete', summary: 'Build succeeded' }
    ], 2);

    const record = manager.getAgentSession('X')!;
    assert.strictEqual(record.events.length, 2);
    assert.strictEqual(record.stepCount, 2);
  });

  test('appendAgentEvents without step increment does not change stepCount', () => {
    manager.createAgentSession('X', 's1', taskDef);
    manager.appendAgentEvents('X', [
      { timestamp: new Date().toISOString(), type: 'message', summary: 'Hello' }
    ]);
    assert.strictEqual(manager.getAgentSession('X')!.stepCount, 0);
  });

  test('setAgentPlan stores plan text', () => {
    manager.createAgentSession('X', 's1', taskDef);
    assert.strictEqual(manager.getAgentSession('X')!.planText, undefined);

    manager.setAgentPlan('X', '1. Read code\n2. Fix bug\n3. Test');
    assert.strictEqual(manager.getAgentSession('X')!.planText, '1. Read code\n2. Fix bug\n3. Test');
  });

  test('updateAgentOutput stores reasoning and response text', () => {
    manager.createAgentSession('X', 's1', taskDef);

    manager.updateAgentOutput('X', {
      reasoningText: 'Think through the failure mode.',
      responseText: 'I will update the parser and add a test.'
    });

    const record = manager.getAgentSession('X')!;
    assert.strictEqual(record.reasoningText, 'Think through the failure mode.');
    assert.strictEqual(record.responseText, 'I will update the parser and add a test.');
  });

  test('updateAgentOutput fires change events', () => {
    manager.createAgentSession('X', 's1', taskDef);

    let reasoningText: string | undefined;
    let responseText: string | undefined;
    const disposable = manager.onDidChangeAgentSession(record => {
      reasoningText = record.reasoningText;
      responseText = record.responseText;
    });

    manager.updateAgentOutput('X', {
      reasoningText: 'Check the live delta stream.',
      responseText: 'Streaming output is now visible.'
    });

    assert.strictEqual(reasoningText, 'Check the live delta stream.');
    assert.strictEqual(responseText, 'Streaming output is now visible.');
    disposable.dispose();
  });

  test('removeAgentSession deletes the record', () => {
    manager.createAgentSession('X', 's1', taskDef);
    assert.ok(manager.getAgentSession('X'));

    manager.removeAgentSession('X');
    assert.strictEqual(manager.getAgentSession('X'), undefined);
  });

  test('removeAgentSession is no-op for unknown key', () => {
    // Should not throw
    manager.removeAgentSession('NOPE');
  });

  test('stores and removes issue workflow assignments', () => {
    manager.setIssueWorkflowAssignment('ISSUE-1', {
      id: 'add-edit-dotnet-web-api',
      name: 'Add/Edit .NET Web API Workflow',
      instructionsPath: '.github/skills/add-edit-dotnet-web-api/SKILL.md'
    }, {
      source: 'manual',
      reason: 'Chosen by user'
    });

    const assignment = manager.getIssueWorkflowAssignment('ISSUE-1');
    assert.ok(assignment);
    assert.strictEqual(assignment?.workflow?.id, 'add-edit-dotnet-web-api');
    assert.strictEqual(assignment?.source, 'manual');
    assert.strictEqual(assignment?.reason, 'Chosen by user');

    manager.removeIssueWorkflowAssignment('ISSUE-1');
    assert.strictEqual(manager.getIssueWorkflowAssignment('ISSUE-1'), undefined);
  });

  test('fires workflow assignment change events', () => {
    let lastIssueKey: string | undefined;
    let lastWorkflowId: string | undefined;
    const disposable = manager.onDidChangeWorkflowAssignment(event => {
      lastIssueKey = event.issueKey;
      lastWorkflowId = event.assignment?.workflow?.id;
    });

    manager.setIssueWorkflowAssignment('ISSUE-2', {
      id: 'frontend-ui',
      name: 'Frontend UI Workflow',
      instructionsPath: '.github/skills/frontend-ui/SKILL.md'
    }, {
      source: 'automatic'
    });

    assert.strictEqual(lastIssueKey, 'ISSUE-2');
    assert.strictEqual(lastWorkflowId, 'frontend-ui');
    disposable.dispose();
  });

  test('onDidChangeAgentSession fires on create', () => {
    let fired: AgentSessionRecord | undefined;
    const disposable = manager.onDidChangeAgentSession(r => { fired = r; });

    manager.createAgentSession('Z', 's1', taskDef);
    assert.ok(fired);
    assert.strictEqual(fired!.issueKey, 'Z');
    disposable.dispose();
  });

  test('onDidChangeAgentSession fires on state change', () => {
    manager.createAgentSession('Z', 's1', taskDef);

    let lastState: AgentTaskState | undefined;
    const disposable = manager.onDidChangeAgentSession(r => { lastState = r.state; });

    manager.updateAgentState('Z', 'executing');
    assert.strictEqual(lastState, 'executing');
    disposable.dispose();
  });

  test('onDidChangeAgentSession fires on append events', () => {
    manager.createAgentSession('Z', 's1', taskDef);

    let eventCount = 0;
    const disposable = manager.onDidChangeAgentSession(r => { eventCount = r.events.length; });

    manager.appendAgentEvents('Z', [
      { timestamp: new Date().toISOString(), type: 'info', summary: 'hi' }
    ]);
    assert.strictEqual(eventCount, 1);
    disposable.dispose();
  });

  test('state machine: full lifecycle not_started → planning → executing → completed', () => {
    manager.createAgentSession('LC', 's1', taskDef);
    const states: AgentTaskState[] = ['not_started'];

    const disposable = manager.onDidChangeAgentSession(r => { states.push(r.state); });

    manager.updateAgentState('LC', 'planning');
    manager.updateAgentState('LC', 'executing');
    manager.updateAgentState('LC', 'completed');

    assert.deepStrictEqual(states, [
      'not_started', // initial from create event
      'planning',
      'executing',
      'completed'
    ]);

    assert.ok(manager.getAgentSession('LC')!.completedAt);
    disposable.dispose();
  });

  test('state machine: executing → awaiting_approval → executing → awaiting_input → executing → completed', () => {
    manager.createAgentSession('PA', 's1', taskDef);
    const transitions: AgentTaskState[] = [];
    const disposable = manager.onDidChangeAgentSession(r => { transitions.push(r.state); });

    manager.updateAgentState('PA', 'planning');
    manager.updateAgentState('PA', 'executing');
    manager.updateAgentState('PA', 'awaiting_approval');
    manager.updateAgentState('PA', 'executing');
    manager.updateAgentState('PA', 'awaiting_input');
    manager.updateAgentState('PA', 'executing');
    manager.updateAgentState('PA', 'completed');

    assert.deepStrictEqual(transitions, [
      'planning',
      'executing',
      'awaiting_approval',
      'executing',
      'awaiting_input',
      'executing',
      'completed'
    ]);
    disposable.dispose();
  });

  test('max steps default is applied correctly', () => {
    const taskWithoutMax: AgentTaskDefinition = {
      goal: 'Test',
      scope: 'test',
      definitionOfDone: 'done'
    };
    const record = manager.createAgentSession('MS', 's1', taskWithoutMax);
    const effectiveMax = record.taskDefinition.maxSteps ?? AGENT_DEFAULTS.maxSteps;
    assert.strictEqual(effectiveMax, AGENT_DEFAULTS.maxSteps);
  });

  test('custom maxSteps is preserved', () => {
    const taskWithMax: AgentTaskDefinition = {
      goal: 'Test',
      scope: 'test',
      definitionOfDone: 'done',
      maxSteps: 10
    };
    const record = manager.createAgentSession('CM', 's1', taskWithMax);
    assert.strictEqual(record.taskDefinition.maxSteps, 10);
  });

  test('createSession stores the selected AI label and fires change events', () => {
    let changedIssueKey: string | undefined;
    let changedLabel: string | undefined;
    const disposable = manager.onDidChangeSession(event => {
      changedIssueKey = event.issueKey;
      changedLabel = event.session?.label;
    });

    const session = manager.createSession('AI-1', 'vercel-gateway', 'Planner Bot');

    assert.strictEqual(session.label, 'Planner Bot');
    assert.strictEqual(manager.getSession('AI-1')?.label, 'Planner Bot');
    assert.strictEqual(changedIssueKey, 'AI-1');
    assert.strictEqual(changedLabel, 'Planner Bot');
    disposable.dispose();
  });

  test('agent terminal states update linked AI assignment status', () => {
    manager.createSession('AI-2', 'vercel-gateway', 'Vercel AI Gateway');
    manager.createAgentSession('AI-2', 'agent-1', taskDef);

    manager.updateAgentState('AI-2', 'executing');
    assert.strictEqual(manager.getSession('AI-2')?.status, 'active');

    manager.updateAgentState('AI-2', 'completed');
    assert.strictEqual(manager.getSession('AI-2')?.status, 'completed');

    manager.createSession('AI-3', 'vercel-gateway', 'Vercel AI Gateway');
    manager.createAgentSession('AI-3', 'agent-2', taskDef);
    manager.updateAgentState('AI-3', 'failed');
    assert.strictEqual(manager.getSession('AI-3')?.status, 'failed');
  });
});
