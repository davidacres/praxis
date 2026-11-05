import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { workflowBaseBlockingPaths, workflowBlockingFiles } from './workflowWorkspace';
import { withBaseCheckout } from './baseCheckoutLock';

function readinessFixture(t: TestContext, status: () => string[]) {
  const folder = '/fixture/workflow-readiness';
  t.mock.method(require('./projectStoreInstance'), 'getProjectStore', () => ({ get: () => ({ workspaceFolder: folder }) }));
  const reads = { count: 0 };
  t.mock.method(require('./gitService'), 'getGitStatus', async () => { reads.count++; return { files: status().map(path => ({ path })) }; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { folder, reads, gate, release: () => release() };
}

test('workflow readiness re-reads after a base-checkout write instead of reporting its half-written file', async t => {
  let writing = true;
  const fixture = readinessFixture(t, () => (writing ? ['plans/ticket.md'] : []));
  const writer = withBaseCheckout(fixture.folder, async () => { await fixture.gate; writing = false; });
  try {
    const reader = workflowBlockingFiles('fixture');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.reads.count, 1, 'the dirty read waits for the write to finish');
    fixture.release();
    await writer;
    assert.deepEqual(await reader, [], 'a partially committed ticket status is never reported as user work');
    assert.equal(fixture.reads.count, 2);
  } finally {
    fixture.release();
    await writer;
  }
});

test('workflow readiness still reports user changes after waiting for a base-checkout write', async t => {
  const fixture = readinessFixture(t, () => ['src/user-edit.ts']);
  const writer = withBaseCheckout(fixture.folder, () => fixture.gate);
  try {
    const reader = workflowBlockingFiles('fixture');
    await new Promise(resolve => setImmediate(resolve));
    fixture.release();
    await writer;
    assert.deepEqual(await reader, ['src/user-edit.ts'], 'real user work is still blocking');
    assert.equal(fixture.reads.count, 2);
  } finally {
    fixture.release();
    await writer;
  }
});

test('workflow readiness of a clean base never waits behind a held checkout such as a long merge', async t => {
  const fixture = readinessFixture(t, () => []);
  const writer = withBaseCheckout(fixture.folder, () => fixture.gate);
  try {
    assert.deepEqual(await workflowBlockingFiles('fixture'), [], 'answered while the checkout is still held');
    assert.equal(fixture.reads.count, 1);
  } finally {
    fixture.release();
    await writer;
  }
});

const changed = (path: string) => ({ path });

test('workflow base readiness ignores only app-owned Praxis metadata', () => {
  assert.deepEqual(
    workflowBaseBlockingPaths([
      changed('.praxis/workflows/governed.json'),
      changed('.praxis/session-artifacts/run.png'),
      changed('project.praxis.md'),
      changed('board.praxis.json'),
      changed('praxis-code.workspace.praxis.json'),
      changed('src/app.ts'),
      changed('e2e/app.spec.ts')
    ]),
    ['src/app.ts', 'e2e/app.spec.ts']
  );
});

test('workflow base readiness normalizes Windows separators before classifying metadata', () => {
  assert.deepEqual(
    workflowBaseBlockingPaths([
      changed('.praxis\\workflows\\governed.json'),
      changed('src\\app.ts')
    ]),
    ['src\\app.ts']
  );
});
