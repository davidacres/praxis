import test from 'node:test';
import assert from 'node:assert/strict';
import { StageHandoverGuard } from './stageHandoverGuard';

test('intentional abort is held until the replacement turn is launched', async () => {
  const guard = new StageHandoverGuard();
  let state = 'executing';
  const settled: string[] = [];
  const check = () => { if (!guard.isHeld('stage') && state !== 'executing') settled.push(state); };
  guard.observe('stage', check);
  await guard.during('stage', async () => {
    state = 'aborted'; check();
    await assert.rejects(guard.during('stage', async () => {}), /already in progress/);
    state = 'executing'; check();
  });
  assert.deepEqual(settled, []);
  state = 'completed'; check();
  assert.deepEqual(settled, ['completed']);
});

test('failed handover releases the waiter and preserves the stopped result', async () => {
  const guard = new StageHandoverGuard();
  let checked = false;
  const dispose = guard.observe('stage', () => { checked = true; });
  await assert.rejects(guard.during('stage', async () => { throw new Error('checkpoint failed'); }), /checkpoint failed/);
  assert.equal(checked, true);
  assert.equal(guard.isHeld('stage'), false);
  dispose();
});
