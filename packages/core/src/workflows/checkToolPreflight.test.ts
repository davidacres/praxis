import test from 'node:test';
import assert from 'node:assert/strict';
import { describeMissingCheckTools, missingCheckTools } from './checkToolPreflight';
import type { WorkflowNode } from './workflowTypes';

const check = (id: string, name: string, command: string, extra: Record<string, unknown> = {}): WorkflowNode =>
  ({ type: 'check', id, name, x: 0, y: 0, inputs: [], command, outputs: [], ...extra }) as WorkflowNode;

const installed = (...names: string[]) => (command: string) => names.includes(command);

test('a missing scanner is reported once, with every stage that runs it and how to install it', () => {
  const missing = missingCheckTools([
    check('sast', 'SAST scan', 'semgrep'),
    check('sast-2', 'SAST (strict)', 'semgrep'),
    check('secrets', 'Secret scan', 'gitleaks'),
    check('typecheck', 'Type check', 'npm')
  ], installed('gitleaks', 'npm'), 'darwin');
  assert.deepEqual(missing, [{ command: 'semgrep', stages: ['SAST scan', 'SAST (strict)'], install: 'brew install semgrep' }]);
  const message = describeMissingCheckTools(missing) ?? '';
  assert.match(message, /semgrep \(needed by SAST scan, SAST \(strict\)\): brew install semgrep\./);
});

test('the install hint follows the platform, with a generic fallback for unknown tools', () => {
  assert.equal(missingCheckTools([check('s', 'S', 'semgrep')], installed(), 'linux')[0].install, 'pipx install semgrep (or pip install semgrep)');
  assert.equal(missingCheckTools([check('g', 'G', 'gitleaks')], installed(), 'win32')[0].install, 'scoop install gitleaks');
  assert.match(missingCheckTools([check('x', 'X', 'acme-lint')], installed(), 'darwin')[0].install, /install acme-lint and make sure it is on your PATH/);
});

test('agent stages and worktree-relative scripts are not judged', () => {
  const looked: string[] = [];
  const missing = missingCheckTools([
    check('script', 'Script', './scripts/lint.sh'),
    { type: 'agent-task', id: 'impl', name: 'Implement', x: 0, y: 0, inputs: [], outputs: [], instructions: '', agent: { scope: 'user', agentId: 'a', toolMode: 'full' } } as unknown as WorkflowNode
  ], command => { looked.push(command); return false; }, 'darwin');
  assert.deepEqual(missing, []);
  assert.deepEqual(looked, []);
});

test('a switched-off check stage is still judged, because the run engine still runs it', () => {
  assert.equal(missingCheckTools([check('off', 'Off', 'semgrep', { enabled: false })], installed(), 'darwin').length, 1);
});

test('an absolute command path is looked up as given', () => {
  assert.equal(missingCheckTools([check('a', 'A', '/opt/tools/scan')], installed(), 'darwin')[0].command, '/opt/tools/scan');
  assert.deepEqual(missingCheckTools([check('a', 'A', '/opt/tools/scan')], installed('/opt/tools/scan'), 'darwin'), []);
});

test('nothing missing means no refusal', () => {
  assert.equal(describeMissingCheckTools([]), undefined);
});
