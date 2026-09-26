import assert from 'node:assert/strict';import test from 'node:test';import {attentionSubject, combineAttention, openMobileAttention, runAttentionItems} from './mobileAttention';
test('filters unresolved attention to host and project scope',()=>{const x=openMobileAttention([{id:'1',kind:'permission',hostId:'h',projectId:'p',createdAt:'',resolved:false},{id:'2',kind:'failure',hostId:'h2',projectId:'p',createdAt:'',resolved:false},{id:'3',kind:'approval',hostId:'h',projectId:'p',createdAt:'',resolved:true}],{hostId:'h',projectId:'p'});assert.deepEqual(x.map(i=>i.id),['1']);});

test('an attention item is named by its run or session, never by a raw id', () => {
  const work = [{ sessionId: 's-1', title: 'Pre-fill the saved address' }, { sessionId: 's-2', runId: 'r-9', title: 'Release review — Checkout 2.4' }];
  assert.equal(attentionSubject({ kind: 'permission', sessionId: 's-1' }, work, {}), 'Pre-fill the saved address');
  assert.equal(attentionSubject({ kind: 'approval', runId: 'r-9' }, work, { 'r-9': { workflowName: 'Release review' } }), 'Release review');
  assert.equal(attentionSubject({ kind: 'approval', runId: 'r-9' }, work, {}), 'Release review — Checkout 2.4');
  assert.equal(attentionSubject({ kind: 'approval', runId: 'unknown' }, work, {}), 'A workflow run');
  assert.equal(attentionSubject({ kind: 'approval', runId: 'r-2', summary: 'Release review — Checkout 2.4' }, [], {}), 'Release review — Checkout 2.4');
  assert.equal(attentionSubject({ kind: 'permission', sessionId: 'unknown' }, work, {}), 'A session');
});

test('run attention is derived from live run snapshots with the desktop\'s ids', () => {
  const items = runAttentionItems('h', 'p', [
    { runId: 'r1', projectId: 'p', workflowName: 'Release', status: 'awaiting-approval', startedAt: 't', stages: [{ nodeId: 'qa', name: 'QA', lane: 'failed' }, { nodeId: 'ok', name: 'Build', lane: 'done' }] },
    { runId: 'r2', projectId: 'other', workflowName: 'Elsewhere', status: 'awaiting-approval', startedAt: 't', stages: [] },
  ]);
  assert.deepEqual(items.map(item => item.id), ['approval:r1', 'failure:r1:qa']);
});

test('combined attention prefers live items, keeps polled extras, and hides what was acted on', () => {
  const item = (id: string, kind: 'permission' | 'approval' | 'failure') => ({ id, kind, hostId: 'h', projectId: 'p', createdAt: '', resolved: false });
  const polled = [item('approval:stale', 'approval'), item('permission:old', 'permission')];
  const withRuns = combineAttention({ polled, permissions: [item('permission:p1', 'permission')], fromRuns: [item('approval:r1', 'approval')], resolvedIds: new Set(['approval:r1']) });
  assert.deepEqual(withRuns.map(entry => [entry.id, entry.resolved]), [['permission:p1', false], ['approval:r1', true]]);
  // Against an old desktop (no run list), the polled approvals are all there is.
  const withoutRuns = combineAttention({ polled, permissions: [], fromRuns: undefined, resolvedIds: new Set() });
  assert.deepEqual(withoutRuns.map(entry => entry.id), ['approval:stale']);
});
