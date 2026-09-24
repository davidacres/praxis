import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fullSdlcTemplate,
  detectStackFromLanguages,
  resolveFullSdlcTemplate,
  builtInWorkflowTemplates,
  fullSdlcMarketplaceTemplates,
  assembleTemplateLibrary,
  assessTemplateReadiness
} from './workflowTemplates';
import { validateWorkflow } from './workflowValidation';
import { getBundledAgentManifests } from '../ai/agentRuntime/bundledAgents';
import { discoverAgentProfiles } from '../ai/agentRuntime/profileRegistry';


/** A skill as the live catalog reports it once installed. */
function installedSkill(name: string) {
  return {
    metadata: { name, description: name, triggers: [] },
    skillPath: `/skills/${name}`,
    instructionsPath: `/skills/${name}/SKILL.md`,
    fingerprint: name,
    scope: 'global' as const,
    trusted: true
  };
}

test('TASK-248: fullSdlcTemplate passes workflow validation', () => {
  const template = fullSdlcTemplate('node');
  const result = validateWorkflow(template);
  assert.strictEqual(result.valid, true, `Validation errors: ${JSON.stringify(result.errors)}`);

  // Verify DAG properties
  assert.strictEqual(template.entryNodeId, 'plan');
  const nodeIds = template.nodes.map(n => n.id);
  assert.ok(nodeIds.includes('plan'));
  assert.ok(nodeIds.includes('implement'));
  assert.ok(nodeIds.includes('lint'));
  assert.ok(nodeIds.includes('typecheck'));
  assert.ok(nodeIds.includes('test'));
  assert.ok(nodeIds.includes('sast'));
  assert.ok(nodeIds.includes('secrets'));
  assert.ok(nodeIds.includes('sca'));
  assert.ok(nodeIds.includes('review'));
  assert.ok(nodeIds.includes('gates'));
  assert.ok(nodeIds.includes('approve'));
  assert.ok(nodeIds.includes('deploy'));

  const approveNode = template.nodes.find(n => n.id === 'approve');
  assert.ok(approveNode && approveNode.type === 'approval');
  assert.deepStrictEqual(approveNode.requiredGates, ['qa', 'security', 'review']);
  assert.strictEqual(approveNode.allowBypass, false);
  assert.ok(approveNode.gateThresholds?.qa);
  assert.ok(approveNode.gateThresholds?.security);
  assert.ok(approveNode.gateThresholds?.review);

  // Deploy node is on an advisory edge
  const deployEdge = template.edges.find(e => e.to === 'deploy');
  assert.ok(deployEdge);
  assert.strictEqual(deployEdge.from, 'approve');
  assert.strictEqual(deployEdge.required, false);
});

test('TASK-248: assessTemplateReadiness against bundled agents reports structureOk and agentsOk', async () => {
  const template = fullSdlcTemplate('node');
  const bundled = getBundledAgentManifests();
  // Bundled stages name a profile (FX-BF-038), so preflight needs the bundled
  // AGENT.md profiles alongside the runtime hosts, the same way the real
  // catalog snapshot supplies both — not just the legacy manifest list.
  const profiles = await discoverAgentProfiles([], [], true);
  const readiness = assessTemplateReadiness(template, {
    agents: bundled,
    profiles,
    skills: ['verification-report', 'visual-verification'].map(installedSkill),
    capabilities: {}
  });

  assert.strictEqual(readiness.structureOk, true);
  assert.strictEqual(readiness.agentsOk, true);
  assert.deepStrictEqual(readiness.blockingByNode, {});
});

test('TASK-249: all stack variants pass validation and share equivalent DAG structure', () => {
  const variants = ['node', 'dotnet', 'python', 'generic'] as const;

  for (const variant of variants) {
    const template = fullSdlcTemplate(variant);
    const result = validateWorkflow(template);
    assert.strictEqual(result.valid, true, `Variant ${variant} failed validation: ${JSON.stringify(result.errors)}`);
    // Every stack is the same pipeline. Only the Node variant adds install + build stages: it is the one
    // whose toolchain needs `node_modules` and build output, neither of which a fresh run worktree has.
    const prepared = variant === 'node';
    assert.strictEqual(template.nodes.length, prepared ? 14 : 12);
    assert.strictEqual(template.edges.length, prepared ? 19 : 17);
    assert.strictEqual(template.nodes.some(node => node.id === 'install'), prepared);
    assert.strictEqual(template.nodes.some(node => node.id === 'build'), prepared);
  }

  // Node: the toolchain checks wait for the install; the scanners and the reviewer do not.
  const node = fullSdlcTemplate('node');
  const install = node.nodes.find(n => n.id === 'install');
  assert.ok(install && install.type === 'check');
  assert.strictEqual(install.command, 'npm');
  assert.deepStrictEqual(install.args, ['ci', '--registry=https://registry.npmjs.org/']);
  const parentOf = (id: string) => node.edges.filter(edge => edge.to === id).map(edge => edge.from);
  // Lint and type check need the install; the unit tests run the built product, so they need the build too.
  for (const id of ['lint', 'typecheck']) assert.deepStrictEqual(parentOf(id), ['install'], id);
  assert.deepStrictEqual(parentOf('build'), ['install']);
  assert.deepStrictEqual(parentOf('test'), ['build']);
  for (const id of ['sast', 'secrets', 'sca', 'review']) assert.deepStrictEqual(parentOf(id), ['implement'], id);
  assert.deepStrictEqual(parentOf('install'), ['implement']);

  // Check specific commands on .NET variant
  const dotnet = fullSdlcTemplate('dotnet');
  const dotnetLint = dotnet.nodes.find(n => n.id === 'lint');
  assert.ok(dotnetLint && dotnetLint.type === 'check');
  assert.strictEqual(dotnetLint.command, 'dotnet');
  assert.deepStrictEqual(dotnetLint.args, ['format', '--verify-no-changes']);

  const dotnetReview = dotnet.nodes.find(n => n.id === 'review');
  assert.ok(dotnetReview && dotnetReview.type === 'agent-task');
  assert.strictEqual(dotnetReview.agent.agentId, 'csharp-dotnet-code-reviewer');
  assert.deepStrictEqual(dotnetReview.agent.skillNames, ['dotnet-solid-dry']);

  // Check generic variant has non-empty placeholder commands
  const generic = fullSdlcTemplate('generic');
  const genericLint = generic.nodes.find(n => n.id === 'lint');
  assert.ok(genericLint && genericLint.type === 'check');
  assert.strictEqual(genericLint.command, 'echo');
});

test('TASK-249: detectStackFromLanguages and resolveFullSdlcTemplate', () => {
  assert.strictEqual(detectStackFromLanguages(['TypeScript', 'JavaScript']), 'node');
  assert.strictEqual(detectStackFromLanguages(['C#', '.NET']), 'dotnet');
  assert.strictEqual(detectStackFromLanguages(['Python']), 'python');
  assert.strictEqual(detectStackFromLanguages(['Go', 'Rust']), 'generic');
  assert.strictEqual(detectStackFromLanguages([]), 'generic');

  const resolvedNode = resolveFullSdlcTemplate(['TypeScript']);
  assert.strictEqual(resolvedNode.id, 'full-sdlc');

  const resolvedDotnet = resolveFullSdlcTemplate({ languages: ['C#'] });
  assert.strictEqual(resolvedDotnet.id, 'full-sdlc-dotnet');

  const resolvedGeneric = resolveFullSdlcTemplate({ languages: ['Ruby'] });
  assert.strictEqual(resolvedGeneric.id, 'full-sdlc-generic');
});

test('TASK-248: builtInWorkflowTemplates only includes default built-ins; full-sdlc variants are marketplace templates', () => {
  const builtIns = builtInWorkflowTemplates();
  const builtInIds = builtIns.map(t => t.id);
  assert.ok(builtInIds.includes('governed-delivery'));
  assert.ok(builtInIds.includes('quick-change'));
  assert.strictEqual(builtInIds.includes('full-sdlc'), false);
  assert.strictEqual(builtInIds.includes('full-sdlc-dotnet'), false);
  assert.strictEqual(builtInIds.includes('full-sdlc-python'), false);
  assert.strictEqual(builtInIds.includes('full-sdlc-generic'), false);

  const marketplaceTemplates = fullSdlcMarketplaceTemplates();
  const marketplaceIds = marketplaceTemplates.map(t => t.id);
  assert.ok(marketplaceIds.includes('full-sdlc'));
  assert.ok(marketplaceIds.includes('full-sdlc-dotnet'));
  assert.ok(marketplaceIds.includes('full-sdlc-python'));
  assert.ok(marketplaceIds.includes('full-sdlc-generic'));
  assert.ok(marketplaceTemplates.every(t => !t.builtIn));
});

test('assembleTemplateLibrary returns 2 built-in and 8 marketplace templates by default', () => {
  const library = assembleTemplateLibrary();
  const builtIns = library.filter(t => t.source === 'built-in');
  const marketplace = library.filter(t => t.source === 'marketplace');

  assert.strictEqual(builtIns.length, 2, 'exactly 2 built-in templates');
  assert.strictEqual(marketplace.length, 8, '4 full-sdlc + 4 full-sdlc-loop templates');

  assert.deepStrictEqual(builtIns.map(t => t.definition.id), ['governed-delivery', 'quick-change']);
  assert.ok(builtIns.every(t => t.builtIn === true));

  assert.deepStrictEqual(marketplace.map(t => t.definition.id), [
    'full-sdlc',
    'full-sdlc-dotnet',
    'full-sdlc-python',
    'full-sdlc-generic',
    'full-sdlc-loop',
    'full-sdlc-loop-dotnet',
    'full-sdlc-loop-python',
    'full-sdlc-loop-generic'
  ]);
  assert.ok(marketplace.every(t => t.builtIn === false));
});

test('full-sdlc-dotnet identifies agent dependencies and reports autoInstallable when available', () => {
  const dotnet = fullSdlcTemplate('dotnet');
  const bundled = getBundledAgentManifests();
  const catalog = {
    agents: bundled, // contains planner, implementer, reviewer, etc. but not csharp reviewer
    skills: ['verification-report', 'visual-verification'].map(installedSkill),
    capabilities: {}
  };

  const readiness = assessTemplateReadiness(dotnet, catalog);
  assert.strictEqual(readiness.structureOk, true);
  // Agents are not all in the live catalog yet, so agentsOk is false...
  assert.strictEqual(readiness.agentsOk, false);
  // ...BUT autoInstallable is true because csharp-dotnet-code-reviewer and dotnet-solid-dry are available!
  assert.strictEqual(readiness.autoInstallable, true);

  const deps = readiness.dependencies;
  assert.ok(deps && deps.length >= 3);

  const plannerDep = deps.find(d => d.agentId === 'praxis-planner');
  assert.ok(plannerDep);
  assert.strictEqual(plannerDep.status, 'installed');

  const implementerDep = deps.find(d => d.agentId === 'praxis-implementer');
  assert.ok(implementerDep);
  assert.strictEqual(implementerDep.status, 'installed');

  const csharpDep = deps.find(d => d.agentId === 'csharp-dotnet-code-reviewer');
  assert.ok(csharpDep);
  assert.strictEqual(csharpDep.status, 'available');
  assert.deepStrictEqual(csharpDep.skillNames, ['dotnet-solid-dry']);
  // Wording tracks the FX-BF-038 profile/runtime-host split ("runtime host
  // ..., skills (...) available for installation"), not the old "agent"
  // phrasing this assertion checked before.
  assert.ok(csharpDep.reason?.includes('available for installation'));
});
