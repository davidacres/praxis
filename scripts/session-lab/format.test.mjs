import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTap, sanitizer, materialize, validateBundle } from './format.mjs';
import { modelEvidence, TimelinePlayer, replaySegments, matchesRequest } from './replay.mjs';

test('ACP framing preserves split unicode and interleaved directions and rejects truncation', () => {
  const message=Buffer.from('{"text":"🌍"}\n');
  const cut=message.indexOf(Buffer.from('🌍'))+2;
  const row=(direction,bytes,at)=>({kind:'bytes',direction,bytes:bytes.toString('base64'),at});
  const frames=parseTap([row('from-agent',message.subarray(0,cut),0),row('to-agent',Buffer.from('{"id":1}\n'),1),row('from-agent',message.subarray(cut),2)]);
  assert.deepEqual(frames.map(r=>r.message),[{id:1},{text:'🌍'}]);
  assert.throws(()=>parseTap([row('from-agent',message.subarray(0,cut),0)]),/Truncated/);
});
test('sanitizer removes secrets and endpoints without erasing token accounting', () => {
  const clean=sanitizer([['/tmp/work','<WORKSPACE>']]);
  const output=clean({apiKey:'secret',headers:[{name:'Authorization',value:'secret'}],text:'read /tmp/work/a via http://127.0.0.1:8123/mcp?token=secret',tokenUsage:{inputTokens:12},contextTokens:45});
  assert.equal(output.apiKey,'<REDACTED>');
  assert.equal(output.headers[0].value,'<REDACTED>');
  assert.ok(!JSON.stringify(output).includes('secret'));
  assert.equal(output.tokenUsage.inputTokens,12);
  assert.equal(output.contextTokens,45);
});
test('model confirmation requires adapter acknowledgement, not a record label', () => {
  const frames=[{direction:'to-agent',message:{id:4,method:'session/set_config_option',params:{configId:'model',value:'chosen'}}},{direction:'from-agent',message:{id:4,error:{message:'unavailable'}}}];
  assert.equal(modelEvidence([{frames}],'chosen').accepted,false);
  frames[1].message={id:4,result:{}};
  assert.equal(modelEvidence([{frames}],'chosen').accepted,true);
  frames[1].message={id:4,result:{configOptions:[{id:'model',currentValue:'substitute'}]}};
  assert.equal(modelEvidence([{frames}],'chosen').accepted,false);
});
test('delta materialization rejects gaps and keeps complete message history', () => {
  assert.deepEqual(materialize({events:['a']},{state:'executing',eventsDelta:{base:1,appended:['b']}}),{state:'executing',events:['a','b']});
  assert.deepEqual(materialize({events:['a','b']},{eventsDelta:{base:1,appended:['b']}}).events,['a','b']);
  assert.deepEqual(materialize({events:['a','b']},{eventsDelta:{base:1,appended:['b','c']}}).events,['a','b','c']);
  assert.throws(()=>materialize({events:[]},{eventsDelta:{base:1,appended:[]}}),/gap/);
});
test('playback pauses pending delivery and restart clears accumulated history',async()=>{
  let pending; const delivered=[];
  const rows=[{at:0,payload:{state:'executing',events:[]}},{at:10,payload:{state:'completed',events:['answer']}}];
  const player=new TimelinePlayer(rows,async(row,record)=>delivered.push(record),callback=>{pending=callback;return 1;},()=>{});
  await player.restart(); player.play(); player.pause(); await pending();
  assert.equal(player.index,0);
  await player.step(); assert.equal(player.current.state,'completed');
  await player.restart(); assert.deepEqual(player.current.events,[]);
  assert.equal(player.index,0);
});
test('provider replay simulates agent tool requests and rejects different prompts/models',()=>{
  const frames=[{direction:'to-agent',message:{id:1,method:'session/prompt',params:{prompt:[{text:'hello'}]}}},
    {direction:'from-agent',message:{id:10,method:'fs/read_text_file',params:{path:'/private/file'}}},
    {direction:'to-agent',message:{id:10,result:{content:'private'}}},
    {direction:'from-agent',message:{method:'session/update',params:{update:{text:'done'}}}},
    {direction:'from-agent',message:{id:1,result:{stopReason:'end_turn'}}}];
  const segments=replaySegments(frames);
  assert.equal(segments.length,1); assert.equal(segments[0].replies.length,2);
  assert.ok(segments[0].replies.every(r=>r.method!=='fs/read_text_file'));
  assert.equal(matchesRequest(frames[0].message,{method:'session/prompt',params:{prompt:[{text:'unrelated'}]}},['hello']),false);
  assert.equal(matchesRequest({method:'session/set_config_option',params:{configId:'model',value:'a'}},{method:'session/set_config_option',params:{configId:'model',value:'b'}},[]),false);
});
test('incomplete recordings and unsupported schemas cannot replay',()=>{
  assert.throws(()=>validateBundle({schemaVersion:99}),/schema/);
  assert.throws(()=>validateBundle({schemaVersion:1,status:'incomplete'}),/incomplete/);
});

test('scheduled playback advances and stops at the recording end',async()=>{
  let next;
  const delivered=[];
  const player=new TimelinePlayer([{at:0,payload:{events:[]}},{at:10,payload:{state:'completed',events:['answer']}}],async(row,state)=>delivered.push(state),callback=>{next=callback;return 1;},()=>{});
  await player.restart(); player.speed=4; player.play(); await next();
  assert.equal(player.index,1); assert.equal(player.playing,false);
  assert.equal(delivered.length,2); assert.equal(player.error,undefined);
});

test('checked-in live recording is sanitised and both turns confirm the requested model',async()=>{
  const {readJson}=await import('./format.mjs');
  const bundle=validateBundle(readJson(new URL('../../apps/praxis-desktop/e2e/fixtures/session-recordings/codex-sol-two-turn.json.br',import.meta.url).pathname));
  const text=JSON.stringify(bundle);
  assert.ok(!text.includes('/Users/'));
  assert.ok(!/Bearer (?!<REDACTED>)/i.test(text));
  const evidence=modelEvidence(bundle.processes,bundle.model);
  assert.equal(evidence.selections.length,2);
  assert.ok(evidence.selections.every(selection=>selection.accepted && selection.selected===bundle.model));
  assert.ok(evidence.reported.includes(bundle.model));
});

test('wire reply expectations exclude Codex commentary and resumed history',async()=>{
  const {readJson}=await import('./format.mjs'); const {recordedReplies}=await import('./replay.mjs');
  const bundle=readJson(new URL('../../apps/praxis-desktop/e2e/fixtures/session-recordings/codex-sol-two-turn.json.br',import.meta.url).pathname);
  const replies=recordedReplies(bundle);
  assert.equal(replies.length,2);
  assert.ok(replies[0].startsWith('Project **ORBIT-742**'));
  assert.ok(!replies[0].includes('I’ll read'));
  assert.equal(replies[1],bundle.checkpoints[1].record.responseText);
});
