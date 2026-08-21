import * as assert from 'assert';
import {
  computeTaskDesignerTopologicalOrder,
  validateTaskDesignerConnectorGraph
} from '../views/taskDesignerPanelManager';
import { normalizeTaskDesignerPersistedState } from '../views/taskDesignerStatePersistence';

suite('task designer persisted state recovery', () => {
  test('keeps empty undefined state without repair warning', () => {
    const result = normalizeTaskDesignerPersistedState(undefined);

    assert.deepStrictEqual(result.state, { nodes: [], connectors: [], zoom: 1, toolbarPosition: { x: 16, y: 16 } });
    assert.strictEqual(result.repaired, false);
    assert.strictEqual(result.warning, undefined);
  });

  test('recovers invalid non-object payload', () => {
    const result = normalizeTaskDesignerPersistedState('bad-payload');

    assert.deepStrictEqual(result.state, { nodes: [], connectors: [], zoom: 1, toolbarPosition: { x: 16, y: 16 } });
    assert.strictEqual(result.repaired, true);
    assert.match(result.warning ?? '', /persisted payload was invalid/i);
  });

  test('drops invalid entries and reports recovery details', () => {
    const result = normalizeTaskDesignerPersistedState({
      nodes: [
        { id: 'n1', issueKey: 'APP-1', summary: 'one', issueType: 'Story', status: 'Open', projectKey: 'APP', x: 10, y: 20 },
        { id: 'n1', issueKey: 'APP-1', summary: 'duplicate id', issueType: 'Story', status: 'Open', projectKey: 'APP', x: 30, y: 40 },
        { id: 'n2', issueKey: 'APP-2', summary: 'two', issueType: 'Task', status: 'Open', projectKey: 'APP', x: 'bad-x', y: 50 },
        { nope: true }
      ],
      connectors: [
        { id: 'c1', sourceNodeId: 'n1', targetNodeId: 'n2' },
        { id: 'c2', sourceNodeId: 'n2', targetNodeId: 'missing' },
        { id: 'c1', sourceNodeId: 'n2', targetNodeId: 'n1' },
        { id: 'c3', sourceNodeId: 'n1', targetNodeId: 'n2' },
        { id: 'c4', sourceNodeId: 'n2', targetNodeId: 'n2' },
        { nope: true }
      ]
    });

    assert.strictEqual(result.repaired, true);
    assert.strictEqual(result.state.nodes.length, 2);
    assert.strictEqual(result.state.nodes[1]?.id, 'n2');
    assert.strictEqual(result.state.nodes[1]?.x, 584);
    assert.strictEqual(result.state.nodes[1]?.y, 50);
    assert.deepStrictEqual(result.state.connectors, [
      { id: 'c1', sourceNodeId: 'n1', targetNodeId: 'n2' }
    ]);

    const warning = result.warning ?? '';
    assert.match(warning, /invalid node/i);
    assert.match(warning, /duplicate node id/i);
    assert.match(warning, /invalid coordinates/i);
    assert.match(warning, /invalid connector/i);
    assert.match(warning, /stale connector/i);
    assert.match(warning, /duplicate connector id/i);
    assert.match(warning, /duplicate edge/i);
    assert.match(warning, /self-loop connector/i);
  });

  test('infers project keys from issue key styles during recovery', () => {
    const result = normalizeTaskDesignerPersistedState({
      nodes: [
        { id: 'jira', issueKey: 'app_1-42', summary: 'jira' },
        { id: 'gitlab', issueKey: 'group/repo#99', summary: 'gitlab' },
        { id: 'other', issueKey: 'ticket42', summary: 'other' }
      ],
      connectors: []
    });

    assert.deepStrictEqual(
      result.state.nodes
        .filter((node): node is typeof result.state.nodes[number] & { type: 'ticket'; projectKey: string } => node.type === 'ticket')
        .map(node => ({ id: node.id, projectKey: node.projectKey })),
      [
        { id: 'jira', projectKey: 'APP_1' },
        { id: 'gitlab', projectKey: 'group/repo' },
        { id: 'other', projectKey: 'UNKNOWN' }
      ]
    );
  });

  test('keeps connector handle directions when present', () => {
    const result = normalizeTaskDesignerPersistedState({
      nodes: [
        { id: 'n1', type: 'ticket', issueKey: 'APP-1', summary: 'one', issueType: 'Story', status: 'Open', projectKey: 'APP', x: 10, y: 20 },
        { id: 'n2', type: 'ticket', issueKey: 'APP-2', summary: 'two', issueType: 'Task', status: 'Open', projectKey: 'APP', x: 30, y: 40 }
      ],
      connectors: [
        { id: 'c1', sourceNodeId: 'n1', targetNodeId: 'n2', sourceDirection: 'right', targetDirection: 'left' }
      ]
    });

    assert.deepStrictEqual(result.state.connectors, [
      { id: 'c1', sourceNodeId: 'n1', targetNodeId: 'n2', sourceDirection: 'right', targetDirection: 'left' }
    ]);
  });

  test('recovers note nodes with default dimensions', () => {
    const result = normalizeTaskDesignerPersistedState({
      nodes: [
        { id: 'note-1', type: 'note', title: 'Notes', content: 'remember this', x: 25, y: 35 },
        { id: 'ticket-1', issueKey: 'APP-1', summary: 'one', issueType: 'Story', status: 'Open', projectKey: 'APP', x: 10, y: 20 }
      ],
      connectors: []
    });

    assert.deepStrictEqual(result.state.nodes[0], {
      id: 'note-1',
      type: 'note',
      title: 'Notes',
      content: 'remember this',
      x: 25,
      y: 35,
      width: 280,
      height: 190
    });
    assert.strictEqual(result.state.nodes[1]?.type, 'ticket');
    assert.match(result.warning ?? '', /invalid dimensions/i);
  });
});

suite('task designer graph validation and ordering', () => {
  test('rejects duplicate directed edges', () => {
    const error = validateTaskDesignerConnectorGraph([
      { id: 'c1', sourceNodeId: 'a', targetNodeId: 'b' },
      { id: 'c2', sourceNodeId: 'a', targetNodeId: 'b' }
    ]);

    assert.deepStrictEqual(error, {
      code: 'duplicate-edge',
      sourceNodeId: 'a',
      targetNodeId: 'b',
      message: 'Duplicate directed links are not allowed.'
    });
  });

  test('rejects cycles when no duplicate edge exists', () => {
    const error = validateTaskDesignerConnectorGraph([
      { id: 'c1', sourceNodeId: 'a', targetNodeId: 'b' },
      { id: 'c2', sourceNodeId: 'b', targetNodeId: 'c' },
      { id: 'c3', sourceNodeId: 'c', targetNodeId: 'a' }
    ]);

    assert.strictEqual(error?.code, 'cycle');
    assert.strictEqual(error?.message, 'Directed links cannot create cycles.');
  });

  test('computes deterministic topological order and ignores stale links', () => {
    const order = computeTaskDesignerTopologicalOrder(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        { id: 'c1', sourceNodeId: 'a', targetNodeId: 'c' },
        { id: 'c2', sourceNodeId: 'b', targetNodeId: 'c' },
        { id: 'c3', sourceNodeId: 'b', targetNodeId: 'd' },
        { id: 'stale', sourceNodeId: 'missing', targetNodeId: 'a' }
      ]
    );

    assert.deepStrictEqual(order, ['a', 'b', 'c', 'd']);
  });

  test('returns undefined topological order for cycles', () => {
    const order = computeTaskDesignerTopologicalOrder(
      [{ id: 'a' }, { id: 'b' }],
      [
        { id: 'c1', sourceNodeId: 'a', targetNodeId: 'b' },
        { id: 'c2', sourceNodeId: 'b', targetNodeId: 'a' }
      ]
    );

    assert.strictEqual(order, undefined);
  });
});
