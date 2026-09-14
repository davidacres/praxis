import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleTemplateLibrary,
  assessTemplateReadiness,
  builtInWorkflowTemplates,
  duplicateWorkflowDefinition,
  governedDeliveryTemplate,
  instantiateTemplateForProject,
  quickChangeTemplate
} from './workflowTemplates';
import { validateWorkflow } from './workflowValidation';
import { resolveWorkflowCatalog } from './workflowStore';
import type { AgentCatalogSnapshot } from './workflowPreflight';
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from './workflowTypes';
import type { DiscoveredAgent } from '../ai/agentRuntime/manifest';
import type { DiscoveredAgentProfile } from '../ai/agentRuntime/profileRegistry';

const T = '2026-09-02T10:00:00.000Z';

function agent(id: string): DiscoveredAgent {
  return {
    manifest: { schemaVersion: 1, id, name: id, type: 'acp', entry: 'run.js' },
    manifestPath: `/agents/${id}/agent.json`,
    rootPath: `/agents/${id}`,
    scope: 'global',
    trusted: true,
    errors: []
  };
}

function profile(id: string): DiscoveredAgentProfile {
  return {
    profile: { id, name: id, instructions: `Act as ${id}.` },
    profilePath: `/profiles/${id}/AGENT.md`,
    rootPath: `/profiles/${id}`,
    fingerprint: id,
    scope: 'global',
    trusted: true,
    legacy: false
  };
}

const fullCatalog: AgentCatalogSnapshot = {
  agents: [agent('praxis-planner'), agent('praxis-implementer'), agent('praxis-reviewer')],
  profiles: [profile('praxis-planner'), profile('praxis-implementer'), profile('praxis-reviewer')],
  skills: [],
  capabilities: {}
};

// ── Built-ins are sound ──────────────────────────────────────────────────

test('every built-in template passes validation', () => {
  for (const template of builtInWorkflowTemplates()) {
    const result = validateWorkflow(template);
    assert.deepEqual(result.errors, [], `${template.id}: ${JSON.stringify(result.errors)}`);
  }
});

test('the governed delivery template converges review, QA, and security before approval', () => {
  const template = governedDeliveryTemplate();
  const approve = template.nodes.find(node => node.id === 'approve');
  assert.equal(approve?.type, 'approval');
  assert.deepEqual(approve?.type === 'approval' && approve.requiredGates.sort(), ['qa', 'review', 'security']);

  // QA and security are checks, so their gates cannot be agent-asserted.
  const qa = template.nodes.find(node => node.id === 'qa');
  const security = template.nodes.find(node => node.id === 'security');
  assert.equal(qa?.type, 'check');
  assert.equal(security?.type, 'check');
});

test('the quick-change template has no automated gates', () => {
  const template = quickChangeTemplate();
  const approve = template.nodes.find(node => node.id === 'approve');
  assert.deepEqual(approve?.type === 'approval' ? approve.requiredGates : ['x'], []);
});

// ── Library assembly ─────────────────────────────────────────────────────

test('the library lists every tier without collapsing shared ids', () => {
  const projectCopy = instantiateTemplateForProject({
    template: governedDeliveryTemplate(),
    projectId: 'p1',
    newId: 'governed-delivery', // deliberately clashes with the built-in id
    at: T
  });
  const library = assembleTemplateLibrary({ project: [{ definition: projectCopy, path: '/p/x.json' }] });

  const governedEntries = library.filter(entry => entry.definition.id === 'governed-delivery');
  assert.equal(governedEntries.length, 2, 'the user sees both the built-in and the project copy');
  assert.deepEqual(governedEntries.map(entry => entry.source), ['built-in', 'project']);
});

test('built-in templates are flagged so the UI can forbid editing them in place', () => {
  const library = assembleTemplateLibrary();
  assert.ok(library.every(entry => entry.builtIn === (entry.source === 'built-in')));
});

// ── Instantiation ────────────────────────────────────────────────────────

test('instantiating a template for a project produces a valid project-scoped copy', () => {
  const copy = instantiateTemplateForProject({ template: governedDeliveryTemplate(), projectId: 'p1', at: T });
  assert.equal(copy.scope, 'project');
  assert.equal(copy.projectId, 'p1');
  assert.equal(copy.version, 1);
  assert.equal(copy.builtIn, undefined, 'the built-in flag is stripped');
  assert.equal(copy.id, 'governed-delivery-p1');
  assert.deepEqual(validateWorkflow(copy).errors, []);
});

test('the copy keeps agent ids rather than embedding manifests', () => {
  const copy = instantiateTemplateForProject({ template: governedDeliveryTemplate(), projectId: 'p1', at: T });
  const plan = copy.nodes.find(node => node.id === 'plan');
  assert.equal(plan?.type === 'agent-task' && plan.agent.agentId, 'praxis-planner');
  // No manifest, entry, or transport smuggled onto the ref.
  assert.deepEqual(
    plan?.type === 'agent-task' ? Object.keys(plan.agent).sort() : [],
    ['agentId', 'hostId', 'profileId', 'scope', 'toolMode']
  );
});

test('a project copy is accepted by the run catalog as a project source', () => {
  const copy = instantiateTemplateForProject({ template: quickChangeTemplate(), projectId: 'p1', at: T });
  const catalog = resolveWorkflowCatalog({ project: [{ definition: copy, source: 'project', path: '/p/x.json' }] });
  assert.equal(catalog.workflows.length, 1);
  assert.deepEqual(catalog.invalid, []);
});

test('duplicating a definition resets identity and version but keeps the graph', () => {
  const original = governedDeliveryTemplate();
  const copy = duplicateWorkflowDefinition(original, { newId: 'my-delivery', at: T });
  assert.equal(copy.id, 'my-delivery');
  assert.equal(copy.name, 'Governed delivery copy');
  assert.equal(copy.version, 1);
  assert.equal(copy.nodes.length, original.nodes.length);
  assert.deepEqual(validateWorkflow(copy).errors, []);
});

// ── Readiness ────────────────────────────────────────────────────────────

test('a template whose agents all resolve reports ready', () => {
  const readiness = assessTemplateReadiness(governedDeliveryTemplate(), fullCatalog);
  assert.equal(readiness.structureOk, true);
  assert.equal(readiness.agentsOk, true);
  assert.deepEqual(readiness.blockingByNode, {});
});

test('a missing Agent Hub reference is named per node before any run', () => {
  const thinCatalog: AgentCatalogSnapshot = {
    agents: [agent('praxis-planner')],
    profiles: [profile('praxis-planner')],
    skills: [],
    capabilities: {}
  };
  const readiness = assessTemplateReadiness(governedDeliveryTemplate(), thinCatalog);
  assert.equal(readiness.agentsOk, false);
  assert.ok('implement' in readiness.blockingByNode);
  assert.ok('review' in readiness.blockingByNode);
  assert.match(readiness.blockingByNode.implement, /praxis-implementer/);
  // The stage whose agent does resolve is not flagged.
  assert.equal('plan' in readiness.blockingByNode, false);
});

test('structure and agent readiness are reported independently', () => {
  const broken: WorkflowDefinition = { ...governedDeliveryTemplate(), entryNodeId: 'nonexistent' };
  const readiness = assessTemplateReadiness(broken, fullCatalog);
  assert.equal(readiness.structureOk, false);
  assert.equal(readiness.agentsOk, true, 'agents still resolve even though the graph is broken');
});

// ── Schema ───────────────────────────────────────────────────────────────

test('built-ins declare the current schema version', () => {
  for (const template of builtInWorkflowTemplates()) {
    assert.equal(template.schemaVersion, WORKFLOW_SCHEMA_VERSION);
  }
});
