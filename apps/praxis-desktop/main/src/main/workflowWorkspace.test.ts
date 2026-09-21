import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowBaseBlockingPaths } from './workflowWorkspace';

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
