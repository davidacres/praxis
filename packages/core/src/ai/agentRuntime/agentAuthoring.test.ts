import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAgentManifest,
  buildSkillDoc,
  planNewAgent,
  planNewSkill,
  resolveImportFolder,
  safeJoin,
  safeSegment,
  validateAgentImport,
  validateSkillImport
} from './agentAuthoring';
import type { NewAgentInput, NewSkillInput } from './agentAuthoring';

const agentInput = (over: Partial<NewAgentInput> = {}): NewAgentInput => ({
  scope: 'global',
  name: 'My Reviewer',
  id: 'my-reviewer',
  transport: 'acp',
  command: 'node',
  args: ['run.js'],
  ...over
});

const skillInput = (over: Partial<NewSkillInput> = {}): NewSkillInput => ({
  scope: 'global',
  name: 'code-audit',
  description: 'Audits a diff.',
  ...over
});

test('safeSegment accepts dash-case and rejects traversal / bad shapes', () => {
  assert.equal(safeSegment('praxis-reviewer').name, 'praxis-reviewer');
  assert.ok(safeSegment('../evil').error);
  assert.ok(safeSegment('a/b').error);
  assert.ok(safeSegment('UPPER').error);
  assert.ok(safeSegment('-leading').error);
  assert.ok(safeSegment('a').error, 'single char is too short');
});

test('safeJoin throws when a relative path escapes the root', () => {
  assert.equal(safeJoin('/root', 'sub/file.txt'), '/root/sub/file.txt');
  assert.throws(() => safeJoin('/root', '../outside'));
  assert.throws(() => safeJoin('/root', '/abs'));
});

test('buildAgentManifest requires a command for process transports and a url for network', () => {
  assert.deepEqual(buildAgentManifest(agentInput()).errors, []);
  assert.ok(buildAgentManifest(agentInput({ command: '' })).errors.some(e => /command is required/.test(e)));
  assert.deepEqual(buildAgentManifest(agentInput({ transport: 'http', command: undefined, url: 'https://x' })).errors, []);
  assert.ok(buildAgentManifest(agentInput({ transport: 'gateway', command: undefined, url: undefined })).errors.some(e => /URL is required/.test(e)));
});

test('planNewAgent produces agent.json, and scaffold files only when asked', () => {
  const bare = planNewAgent(agentInput(), []);
  assert.deepEqual(bare.errors, []);
  assert.deepEqual(bare.files.map(f => f.path), ['agent.json']);
  assert.equal(bare.folder, 'my-reviewer');
  const manifest = JSON.parse(bare.files[0].content);
  assert.equal(manifest.entry.command, 'node');

  const scaffolded = planNewAgent(agentInput({ scaffold: true }), []);
  assert.deepEqual(scaffolded.files.map(f => f.path).sort(), ['agent.json', 'index.js', 'package.json']);
  assert.match(scaffolded.files.find(f => f.path === 'index.js')!.content, /SCAFFOLD/);
});

test('planNewAgent fails closed on a duplicate id or unsafe id with no files', () => {
  const dup = planNewAgent(agentInput(), ['my-reviewer']);
  assert.ok(dup.errors.some(e => /already exists/.test(e)));
  assert.deepEqual(dup.files, []);

  const unsafe = planNewAgent(agentInput({ id: '../x' }), []);
  assert.ok(unsafe.errors.length > 0);
  assert.deepEqual(unsafe.files, []);
});

test('buildSkillDoc emits valid closable front matter with optional keys', () => {
  const doc = buildSkillDoc(skillInput({ version: '1.2.0', triggers: ['review', 'audit'] }));
  assert.match(doc, /^---\nname: code-audit\ndescription: Audits a diff\.\nversion: 1\.2\.0\ntriggers: review, audit\n---\n/);
});

test('planNewSkill adds only the requested content folders', () => {
  const plan = planNewSkill(skillInput({ includeScripts: true, includeExamples: true }), []);
  assert.deepEqual(plan.files.map(f => f.path).sort(), ['SKILL.md', 'examples/README.md', 'scripts/README.md']);

  const dup = planNewSkill(skillInput(), ['code-audit']);
  assert.ok(dup.errors.some(e => /already exists/.test(e)));
  assert.deepEqual(dup.files, []);

  const noDesc = planNewSkill(skillInput({ description: '' }), []);
  assert.ok(noDesc.errors.some(e => /description/.test(e)));
});

test('validateAgentImport surfaces manifest errors and duplicate ids', () => {
  const ok = validateAgentImport({ schemaVersion: 1, id: 'imp', name: 'Imp', type: 'acp', entry: 'run.js' }, []);
  assert.deepEqual(ok.preview.errors, []);
  assert.equal(ok.preview.duplicate, false);
  assert.equal(ok.preview.name, 'imp');

  const bad = validateAgentImport({ schemaVersion: 2, id: 'imp', name: 'Imp', type: 'telepathy', entry: 'run.js' }, ['imp']);
  assert.ok(bad.preview.errors.length > 0);
  assert.equal(bad.preview.duplicate, true);
});

test('validateSkillImport catches malformed front matter', () => {
  assert.deepEqual(validateSkillImport('---\nname: audit\ndescription: d\n---\nbody', []).preview.errors, []);
  assert.ok(validateSkillImport('no front matter', []).preview.errors.length > 0);
  assert.ok(validateSkillImport('---\nname: audit\n---\nbody', []).preview.errors.some(e => /description/.test(e)));
});

test('resolveImportFolder blocks or renames on a clash', () => {
  assert.equal(resolveImportFolder('thing', [], 'block').folder, 'thing');
  assert.ok(resolveImportFolder('thing', ['thing'], 'block').error);
  assert.equal(resolveImportFolder('thing', ['thing', 'thing-2'], 'rename').folder, 'thing-3');
});
