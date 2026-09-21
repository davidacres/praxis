import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assembleTemplateLibrary,
  assessTemplateReadiness,
  builtInWorkflowTemplates,
  duplicateWorkflowDefinition,
  governedDeliveryTemplate,
  fullSdlcTemplate,
  instantiateTemplateForProject,
  promoteWorkflowPackToTemplate,
  quickChangeTemplate
} from './workflowTemplates';
import { validateWorkflow } from './workflowValidation';
import { resolveWorkflowCatalog } from './workflowStore';
import type { AgentCatalogSnapshot } from './workflowPreflight';
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from './workflowTypes';
import type { DiscoveredAgent } from '../ai/agentRuntime/manifest';
import type { DiscoveredAgentProfile } from '../ai/agentRuntime/profileRegistry';
import type { DiscoveredSkill } from '../ai/agentRuntime/skillRegistry';
import type { AgentWorkflowReference } from '../ai/agentTypes';

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

function skill(name: string): DiscoveredSkill {
  return {
    metadata: { name, description: name, triggers: [] },
    skillPath: `/skills/${name}`,
    instructionsPath: `/skills/${name}/SKILL.md`,
    fingerprint: name,
    scope: 'global',
    trusted: true
  };
}

const fullCatalog: AgentCatalogSnapshot = {
  agents: [agent('praxis-planner'), agent('praxis-implementer'), agent('praxis-reviewer'), agent('praxis-test-author')],
  profiles: [profile('praxis-planner'), profile('praxis-implementer'), profile('praxis-reviewer'), profile('praxis-test-author')],
  skills: [skill('praxis-test-contracts')],
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

test('full SDLC templates are ticket-triggered while ordinary delivery remains on-demand', () => {
  assert.equal(governedDeliveryTemplate().trigger, undefined);
  assert.equal(fullSdlcTemplate().trigger, 'ticket');
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

test('promoting a workflow pack creates a governed project graph with an explicit approval handoff', () => {
  const pack: AgentWorkflowReference = {
    id: 'secure-review',
    name: 'Secure review',
    instructionsPath: '.github/skills/secure-review/SKILL.md'
  };
  const promoted = promoteWorkflowPackToTemplate({
    pack,
    projectId: 'p1',
    agentId: 'praxis-implementer',
    at: T
  });
  assert.equal(promoted.scope, 'project');
  assert.equal(promoted.nodes.find(node => node.id === 'pack-stage')?.type, 'agent-task');
  const stage = promoted.nodes.find(node => node.id === 'pack-stage');
  assert.equal(stage?.type === 'agent-task' ? stage.workflowPackId : undefined, 'secure-review');
  assert.equal(promoted.nodes.some(node => node.type === 'approval'), true);
  assert.deepEqual(validateWorkflow(promoted).errors, []);
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
  assert.ok('test-contracts' in readiness.blockingByNode);
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

test('the governed-delivery security scan audits against the public registry, so a private default registry cannot fail it', () => {
  const template = builtInWorkflowTemplates().find(candidate => candidate.id === 'governed-delivery');
  const security = template?.nodes.find(node => node.id === 'security');
  assert.ok(security && security.type === 'check');
  assert.equal(security.command, 'npm');
  assert.deepEqual(security.args, ['audit', '--audit-level=high', '--registry=https://registry.npmjs.org/']);
});

test('governed delivery installs dependencies and builds before QA, and validates', () => {
  const template = builtInWorkflowTemplates().find(candidate => candidate.id === 'governed-delivery');
  assert.ok(template);
  assert.equal(validateWorkflow(template).valid, true);

  const install = template.nodes.find(node => node.id === 'install');
  assert.ok(install && install.type === 'check');
  assert.equal(install.name, 'Install dependencies');
  // Public registry: a private default registry 404s on the lockfile's registry.npmjs.org tarballs.
  assert.deepEqual(install.args, ['ci', '--registry=https://registry.npmjs.org/']);
  assert.ok((install.timeoutMs ?? 0) >= 300000, 'a cold install of a workspace takes minutes');
  assert.ok((install.maxAttempts ?? 1) >= 2);
  // Not a gate: it produces no verdict, it prepares the tree.
  assert.equal(install.satisfiesGate, undefined);

  const parents = (id: string) => template.edges.filter(edge => edge.to === id).map(edge => edge.from);
  assert.deepEqual(parents('install'), ['test-contracts']);

  // A run worktree has no build output either (gitignored), so anything that runs the built product —
  // a desktop app's e2e suite opens a blank window — fails for a reason that looks nothing like "build".
  const build = template.nodes.find(node => node.id === 'build');
  assert.ok(build && build.type === 'check');
  assert.deepEqual(build.args, ['run', 'build', '--if-present']);
  // `--if-present` is a silent no-op without a build script, so an empty log must not fail the stage.
  assert.equal(build.outputs.every(output => output.required === false), true);
  assert.equal(build.satisfiesGate, undefined);
  assert.deepEqual(parents('build'), ['install']);

  // QA waits for the build; the security scan reads the lockfile and does not.
  assert.deepEqual(parents('qa'), ['build']);
  assert.deepEqual(parents('security'), ['test-contracts']);
  assert.deepEqual(parents('review'), ['test-contracts']);
});
