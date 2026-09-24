import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublishablePlan, planIssueInputs, PUBLISHABLE_PLAN_INSTRUCTIONS } from './workflowPlanPublishing';
import { buildStageTaskDefinition, formatUpstreamLogs, stageOutcomeFromSession } from './workflowStageTask';
import { parseReviewFindings } from '../ai/aiReviewService';
import { validateWorkflow, normalizeWorkflow } from './workflowValidation';
import { fullSdlcMarketplaceTemplates } from './workflowTemplates';
import type { WorkflowAgentTaskNode, WorkflowDefinition } from './workflowTypes';

const planBlock = (plan: unknown) => `Here is the plan overview.\n\n\`\`\`praxis-plan\n${JSON.stringify(plan)}\n\`\`\`\n`;

const PLAN = {
  feature: { title: 'Security remediation — 2026-09-24', description: '## Summary\nThree items.' },
  items: [
    { type: 'Task', priority: 'P2', title: 'Pin CI actions to commit SHAs', description: 'Change `.github/workflows/*.yml`.' },
    { type: 'bug', priority: 'p0', title: '[P0] Parameterise the order search query', description: 'SEC-001.' },
    { type: 'Story', priority: 'P0', title: 'Validate uploaded archive paths', description: 'SEC-002.' }
  ]
};

test('parsePublishablePlan reads the last praxis-plan block and normalises items', () => {
  const plan = parsePublishablePlan(`${planBlock({ feature: { title: 'Draft' }, items: [{ title: 'x' }] })}\n${planBlock(PLAN)}`);
  assert.equal(plan.feature.title, 'Security remediation — 2026-09-24');
  assert.deepEqual(
    plan.items.map(item => [item.type, item.priority, item.title]),
    [
      ['Task', 'P2', 'Pin CI actions to commit SHAs'],
      ['Bug', 'P0', 'Parameterise the order search query'],
      ['Story', 'P0', 'Validate uploaded archive paths']
    ]
  );
});

test('parsePublishablePlan says what is wrong, so a retry can fix it', () => {
  assert.throws(() => parsePublishablePlan('Just prose.'), /without a `praxis-plan` block/);
  assert.throws(() => parsePublishablePlan('```praxis-plan\n{ not json\n```'), /not valid JSON/);
  assert.throws(() => parsePublishablePlan(planBlock({ feature: { title: 'T' }, items: [] })), /no items/);
  assert.throws(() => parsePublishablePlan(planBlock({ feature: { title: '' }, items: [{ title: 'x' }] })), /feature.title/);
  assert.throws(() => parsePublishablePlan(planBlock({ feature: { title: 'T' }, items: [{ priority: 'P1' }] })), /item 1 has no title/);
  // An unknown priority or type is not fatal: it falls back rather than losing the item.
  const lenient = parsePublishablePlan(planBlock({ feature: { title: 'T' }, items: [{ title: 'x', priority: 'urgent', type: 'Epic' }] }));
  assert.deepEqual([lenient.items[0].priority, lenient.items[0].type], ['P2', 'Task']);
});

test('planIssueInputs creates the feature, then items in priority order under it', () => {
  const inputs = planIssueInputs(parsePublishablePlan(planBlock(PLAN)), 'AUDIT');
  assert.deepEqual(inputs.feature, {
    projectKey: 'AUDIT',
    issueType: 'Feature',
    summary: 'Security remediation — 2026-09-24',
    description: '## Summary\nThree items.'
  });
  const items = inputs.items('AUDIT-F03');
  assert.deepEqual(
    items.map(item => item.summary),
    ['[P0] Parameterise the order search query', '[P0] Validate uploaded archive paths', '[P2] Pin CI actions to commit SHAs']
  );
  assert.ok(items.every(item => item.parentKey === 'AUDIT-F03' && item.projectKey === 'AUDIT'));
  assert.match(items[0].description ?? '', /^\*\*Priority:\*\* P0 · Part of plan AUDIT-F03: Security remediation — 2026-09-24\n\nSEC-001\.$/);
});

const agentNode = (outputs: WorkflowAgentTaskNode['outputs']): WorkflowAgentTaskNode => ({
  type: 'agent-task',
  id: 'review',
  name: 'Security review',
  x: 0,
  y: 0,
  inputs: [],
  agent: { agentId: 'praxis-security-analyst', scope: 'global', toolMode: 'read-only' },
  instructions: 'Review.',
  outputs,
  mutatesWorktree: false
});

const REPORT_WITH_FINDINGS = [
  '# Security Review Report',
  'Evidence:',
  '```ts',
  'db.query(`SELECT * FROM orders WHERE id = ${id}`);',
  '```',
  '## Findings register',
  '```json',
  JSON.stringify({
    summary: 'One critical issue.',
    findings: [
      { file: 'src/orders.ts', line: 12, severity: 'critical', category: 'CWE-89', message: 'SEC-001 SQL injection in order search', suggestion: 'Use a parameterised query.' }
    ]
  }),
  '```'
].join('\n');

test('an agent stage delivers its findings output from the JSON block after its report', () => {
  const outcome = stageOutcomeFromSession(
    agentNode([
      { id: 'security-report', kind: 'report', required: true },
      { id: 'security-findings', kind: 'findings', required: true }
    ]),
    { state: 'completed', responseText: REPORT_WITH_FINDINGS }
  );
  assert.equal(outcome.status, 'succeeded');
  assert.deepEqual(outcome.artifacts?.map(artifact => artifact.contractId).sort(), ['security-findings', 'security-report']);
  assert.equal(outcome.findings?.findings.length, 1);
  assert.deepEqual(
    [outcome.findings?.findings[0].file, outcome.findings?.findings[0].line, outcome.findings?.findings[0].severity],
    ['src/orders.ts', 12, 'critical']
  );
});

test('an agent stage with prose only does not claim a findings output', () => {
  const outcome = stageOutcomeFromSession(agentNode([{ id: 'f', kind: 'findings', required: true }]), {
    state: 'completed',
    responseText: 'Looks fine to me.'
  });
  assert.equal(outcome.findings, undefined);
  assert.deepEqual(outcome.artifacts, []);
});

test('parseReviewFindings skips quoted code blocks and reads the findings block', () => {
  assert.equal(parseReviewFindings(REPORT_WITH_FINDINGS).findings.findings[0].message, 'SEC-001 SQL injection in order search');
});

test('a stage is told the findings and plan formats it will be held to', () => {
  const task = buildStageTaskDefinition({
    runId: 'r',
    nodeId: 'n',
    stageName: 'Plan',
    instructions: 'Plan it.',
    inputs: [],
    expectedOutputs: [
      { id: 'f', kind: 'findings', required: true },
      { id: 'p', kind: 'plan', required: true, publishTo: 'board' }
    ]
  });
  assert.match(task.definitionOfDone ?? '', /last fenced ```json block/);
  assert.ok((task.definitionOfDone ?? '').includes(PUBLISHABLE_PLAN_INSTRUCTIONS));
});

test('formatUpstreamLogs inlines check output, capped with head and tail', () => {
  const out = formatUpstreamLogs(
    [
      { contractId: 'sast-log', stageName: 'SAST', text: 'SKIPPED: semgrep is not installed.' },
      { contractId: 'deps-log', stageName: 'Deps', text: `${'a'.repeat(50)}${'b'.repeat(50)}` },
      { contractId: 'empty', stageName: 'Empty', text: '  ' }
    ],
    40
  );
  assert.match(out ?? '', /### "sast-log" from SAST\n```text\nSKIPPED: semgrep is not installed.\n```/);
  assert.match(out ?? '', /a{20}\n\n\[… 60 characters omitted …\]\n\nb{20}/);
  assert.doesNotMatch(out ?? '', /empty/);
  assert.equal(formatUpstreamLogs([]), undefined);
});

test('only an agent stage plan output can be published to the board', () => {
  const definition: WorkflowDefinition = normalizeWorkflow({
    schemaVersion: 1,
    id: 'w',
    name: 'W',
    scope: 'global',
    version: 1,
    entryNodeId: 'a',
    createdAt: '',
    updatedAt: '',
    nodes: [{ ...agentNode([{ id: 'r', kind: 'report', required: true, publishTo: 'board' }]), id: 'a' }],
    edges: []
  });
  assert.equal(definition.nodes[0].type === 'agent-task' && definition.nodes[0].outputs[0].publishTo, 'board');
  assert.match(JSON.stringify(validateWorkflow(definition).errors), /Only a plan output of an agent stage can be published/);
});

test('saving a workflow keeps its gate thresholds, waivers and scanner adapters', () => {
  const templates = fullSdlcMarketplaceTemplates();
  const pick = (definition: WorkflowDefinition) =>
    definition.nodes.map(node => ({
      id: node.id,
      ...(node.type === 'approval' ? { gateThresholds: node.gateThresholds, waivers: node.waivers } : {}),
      ...(node.type === 'check'
        ? { adapter: node.adapter, reportPath: node.reportPath, observe: node.observe, outputAdapters: node.outputs.map(output => output.adapter) }
        : {})
    }));
  let checked = 0;
  for (const template of templates) {
    const saved = normalizeWorkflow(JSON.parse(JSON.stringify(template)));
    assert.deepEqual(JSON.parse(JSON.stringify(pick(saved))), JSON.parse(JSON.stringify(pick(template))), template.id);
    checked += template.nodes.filter(node => (node.type === 'approval' && node.gateThresholds) || (node.type === 'check' && node.reportPath)).length;
  }
  assert.ok(checked > 0, 'the templates exercise thresholds and report paths');
});
