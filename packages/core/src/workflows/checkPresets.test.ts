import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHECK_PRESETS,
  SECRET_SCAN_PRESET,
  SAST_SEMGREP_PRESET,
  SCA_OSV_PRESET,
  SCA_TRIVY_PRESET,
  detectRecommendedCheckPresets,
  createCheckNodeFromPreset
} from './checkPresets';

test('detectRecommendedCheckPresets picks default set for Node / TypeScript projects', () => {
  const presets = detectRecommendedCheckPresets({
    languages: ['TypeScript', 'JavaScript'],
    manifests: ['package.json', 'package-lock.json'],
    frameworks: ['React']
  });

  const ids = presets.map(p => p.id);
  assert.ok(ids.includes('secret-scan'), 'should include secret scanning');
  assert.ok(ids.includes('sast-semgrep'), 'should include semgrep SAST');
  assert.ok(ids.includes('sca-osv'), 'should include osv-scanner SCA');
  assert.strictEqual(ids.includes('sca-trivy'), false, 'should not include trivy for plain Node');
});

test('detectRecommendedCheckPresets includes .NET SCA target for .NET / C# projects', () => {
  const presets = detectRecommendedCheckPresets({
    languages: ['C#'],
    manifests: ['App.csproj'],
    frameworks: ['.NET']
  });

  const ids = presets.map(p => p.id);
  assert.ok(ids.includes('secret-scan'), 'should include secret scanning');
  assert.ok(ids.includes('sast-semgrep'), 'should include semgrep SAST');
  assert.ok(ids.includes('sca-trivy'), 'should include trivy .NET SCA target');
});

test('detectRecommendedCheckPresets always includes secrets even for empty projects', () => {
  const presets = detectRecommendedCheckPresets({});
  assert.strictEqual(presets.length, 1);
  assert.strictEqual(presets[0].id, 'secret-scan');
});

test('createCheckNodeFromPreset generates valid WorkflowCheckNode with findings output', () => {
  const node = createCheckNodeFromPreset(SECRET_SCAN_PRESET);
  assert.strictEqual(node.id, 'secret-scan');
  assert.strictEqual(node.type, 'check');
  assert.strictEqual(node.command, 'gitleaks');
  assert.strictEqual(node.adapter, 'sarif');
  assert.strictEqual(node.satisfiesGate, 'security');
  assert.strictEqual(node.outputs.length, 1);
  assert.strictEqual(node.outputs[0].kind, 'findings');
  assert.strictEqual(node.outputs[0].adapter, 'sarif');
});
