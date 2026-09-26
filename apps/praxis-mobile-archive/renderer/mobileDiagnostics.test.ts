import assert from 'node:assert/strict';
import test from 'node:test';
import { addDiagnostic, describeStaleness, diagnosticMessage, syncFailed, syncSucceeded } from './mobileDiagnostics';

test('diagnostics keep the newest entries first, bounded', () => {
  let list = addDiagnostic([], { at: '1', what: 'a', message: 'x' }, 2);
  list = addDiagnostic(list, { at: '2', what: 'b', message: 'y' }, 2);
  list = addDiagnostic(list, { at: '3', what: 'c', message: 'z' }, 2);
  assert.deepEqual(list.map(entry => entry.at), ['3', '2']);
  assert.equal(diagnosticMessage(new Error('boom')), 'boom');
  assert.equal(diagnosticMessage(undefined), 'Unknown error');
});

test('a failing refresh says what failed and how old the data is, until the next success', () => {
  const clock = (iso: string) => iso.slice(11, 16);
  let state = syncSucceeded({}, '2026-09-24T10:00:00.000Z');
  assert.equal(describeStaleness(state, clock), undefined);
  state = syncFailed(state, 'Refreshing attention', 'socket closed', '2026-09-24T10:05:00.000Z');
  state = syncFailed(state, 'Refreshing attention', 'timed out', '2026-09-24T10:06:00.000Z');
  assert.equal(state.failing?.since, '2026-09-24T10:05:00.000Z');
  assert.equal(describeStaleness(state, clock), 'Refreshing attention failed: timed out. Showing what was last received at 10:00.');
  assert.equal(describeStaleness(syncSucceeded(state, '2026-09-24T10:07:00.000Z'), clock), undefined);
});
