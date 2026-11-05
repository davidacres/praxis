import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowBaseBlockingPaths, workflowBlockingFiles } from './workflowWorkspace';
import { withBaseCheckout } from './baseCheckoutLock';

test('workflow readiness waits for a base-checkout write and still reports user changes', async t => {
  const folder = '/fixture/workflow-readiness';
  t.mock.method(require('./projectStoreInstance'), 'getProjectStore', () => ({ get: () => ({ workspaceFolder: folder }) }));
  let reads = 0;
  t.mock.method(require('./gitService'), 'getGitStatus', async () => { reads++; return { files: [{ path: 'src/user-edit.ts' }] }; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writer = withBaseCheckout(folder, () => gate);
  try {
    const reader = workflowBlockingFiles('fixture');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads, 0, 'readiness cannot observe a partially committed ticket status');
    release();
    await writer;
    assert.deepEqual(await reader, ['src/user-edit.ts'], 'real user work is still blocking');
    assert.equal(reads, 1);
  } finally {
    release();
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
