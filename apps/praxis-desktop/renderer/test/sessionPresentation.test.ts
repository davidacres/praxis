import test from 'node:test';
import assert from 'node:assert/strict';
import { collectTurnTools } from '../src/ai/chatToolCalls.ts';
import { collectMessageRuns } from '../src/ai/chatTurns.ts';
import type { AgentEventSummary } from '@praxis/core';
const event=(type:AgentEventSummary['type'],data?:AgentEventSummary['data']):AgentEventSummary=>({type,timestamp:'2026-11-14T15:00:00Z',summary:type,data});
test('completed tool history retains refined details and does not require reasoning',()=>{
  const reply=event('message');
  const rows=collectTurnTools([
    event('tool_start',{callId:'read',toolName:'Read',kind:'read',argsSummary:'Read File'}),
    event('tool_complete',{callId:'read',toolName:'Read',kind:'read',argsSummary:'Read fixture.txt',locations:[{path:'fixture.txt',line:1}],args:{file_path:'fixture.txt'},ok:true}),reply
  ]).get(reply)!.calls;
  assert.equal(rows.length,1); assert.equal(rows[0].detail,'Read fixture.txt');
  assert.equal(rows[0].locations?.[0].line,1); assert.equal(rows[0].output,undefined);
  assert.equal(rows[0].ok,true); assert.equal(rows[0].kind,'read');
});
test('explicit unclassified provider messages are not guessed to be commentary from their wording',()=>{
  const reply={...event('message'),detail:'I’ll inspect the file.',messageSegments:[{messageId:'id',phase:null,text:'I’ll inspect the file.',timestamp:'2026-11-14T15:00:00Z'}]};
  const runs=collectMessageRuns([reply],item=>item.detail||'');
  assert.deepEqual(runs[0].narration,[]); assert.deepEqual(runs[0].parts,['I’ll inspect the file.']);
});
