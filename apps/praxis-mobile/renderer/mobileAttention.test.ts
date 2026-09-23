import assert from 'node:assert/strict';import test from 'node:test';import {attentionSubject, openMobileAttention} from './mobileAttention';
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
