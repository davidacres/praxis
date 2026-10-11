const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const babel = require('@babel/core');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-subagent-status-'));
for (const name of ['sessionNav', 'aiSessionState', 'modelProviders']) {
  const source = path.join(__dirname, '..', 'src', 'ai', `${name}.ts`);
  const { code } = babel.transformFileSync(source, {
    configFile: false,
    babelrc: false,
    plugins: ['@babel/plugin-transform-typescript', '@babel/plugin-transform-modules-commonjs']
  });
  fs.writeFileSync(path.join(temporary, `${name}.js`), code);
}
const { extractSubagents } = require(path.join(temporary, 'sessionNav.js'));
test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
const start = (id = 'agent-1') => ({ type: 'tool_start', timestamp: '2026-10-11T12:00:00Z', summary: 'Running tool: Subagent investigation', data: { callId: id, toolName: 'subagent', argsSummary: 'Investigate the boundary' } });
const finish = (id = 'agent-1', ok = true) => ({ type: 'tool_complete', timestamp: '2026-10-11T12:00:10Z', summary: 'Tool completed', data: { callId: id, ok } });
const parent = events => ({ issueKey: 'SESSION-parent', state: 'executing', model: 'parent-model', taskDefinition: { kind: 'general', goal: 'Parent' }, events });

test('completion without a tool name settles the existing row and retains its title', () => {
  const rows = extractSubagents(parent([start(), finish()]));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[0].title, 'Investigate the boundary');
  assert.equal(rows[0].startedAt, start().timestamp);
  assert.equal(rows[0].completedAt, finish().timestamp);
});

test('failed completion settles only its call while another agent remains executing', () => {
  const rows = extractSubagents(parent([start('first'), start('second'), finish('first', false)]));
  assert.deepEqual(rows.map(row => [row.id, row.status]), [['first', 'failed'], ['second', 'executing']]);
});

test('completion metadata updates usage and a duplicate start cannot reopen a settled call', () => {
  const completed = { ...finish(), modelId: 'review-model', durationMs: 2500, tokenUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 }, cost: { amount: 0.01 } };
  const row = extractSubagents(parent([start(), completed, start()]))[0];
  assert.equal(row.status, 'completed');
  assert.equal(row.model, 'review-model');
  assert.equal(row.tokenUsage.totalTokens, 30);
  assert.equal(row.elapsed, '3s');
});

test('completion-only history is supported and linked child sessions retain their authoritative state', () => {
  const named = { ...finish(), data: { ...finish().data, toolName: 'subagent' } };
  assert.equal(extractSubagents(parent([named]))[0].status, 'completed');
  const child = { issueKey: 'agent-1', parentSessionKey: 'SESSION-parent', state: 'awaiting_input', taskDefinition: { kind: 'general', goal: 'Live child' }, events: [] };
  const rows = extractSubagents(parent([start(), finish()]), [child]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'awaiting_input');
});

test('shell commands mentioning subagents are not classified as agents', () => {
  const shell = { ...start('shell'), data: { callId: 'shell', toolName: "rg 'subagent' renderer/src" } };
  const native = { ...start('child'), data: { callId: 'child', toolName: 'Start subagent reviewer' } };
  const rows = extractSubagents(parent([shell, native, finish('child')]));
  assert.deepEqual(rows.map(row => [row.id, row.status]), [['child', 'executing']]);
});

test('legacy native lifecycle notifications settle two agents rather than seven executing control actions', () => {
  const action = (label, id) => ({ ...start(id), data: { callId: id, toolName: label } });
  const events = [
    action('Start subagent investigator', 'start-first'),
    action('Interact with subagent investigator', 'interact-first'),
    action('Complete subagent investigator', 'complete-first'),
    action('Start subagent reviewer', 'start-second'),
    action('Complete subagent reviewer', 'complete-second'),
    action('Interrupt subagent investigator', 'interrupt-first'),
    action('Interrupt subagent reviewer', 'interrupt-second')
  ];
  const rows = extractSubagents(parent(events));
  assert.deepEqual(rows.map(row => [row.title, row.status]), [['investigator', 'completed'], ['reviewer', 'completed']]);
});

test('finishing the spawn tool does not finish the child agent', () => {
  const native = { ...start('spawn'), data: { callId: 'spawn', toolName: 'Start subagent reviewer' } };
  assert.equal(extractSubagents(parent([native, finish('spawn')]))[0].status, 'executing');
});

test('the affected saved transcript reports two completed agents', { skip: !process.env.PRAXIS_SUBAGENT_HISTORY_FIXTURE }, () => {
  const transcript = JSON.parse(fs.readFileSync(process.env.PRAXIS_SUBAGENT_HISTORY_FIXTURE, 'utf8'));
  const rows = extractSubagents(parent(transcript.events));
  assert.deepEqual(rows.map(row => [row.title, row.status]), [['f107_boundary_investigation', 'completed'], ['f107_candidate_review', 'completed']]);
});
