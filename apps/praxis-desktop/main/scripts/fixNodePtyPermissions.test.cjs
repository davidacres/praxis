const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { fixNodePtyPermissions } = require('./fixNodePtyPermissions.cjs');

test('cold macOS installs make every node-pty spawn helper executable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-node-pty-'));
  try {
    const prebuild = path.join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    const sourceBuild = path.join(root, 'build', 'Release', 'spawn-helper');
    for (const helper of [prebuild, sourceBuild]) {
      fs.mkdirSync(path.dirname(helper), { recursive: true });
      fs.writeFileSync(helper, 'fixture', { mode: 0o644 });
    }

    assert.deepEqual(fixNodePtyPermissions(root, 'darwin').sort(), [prebuild, sourceBuild].sort());
    assert.equal(fs.statSync(prebuild).mode & 0o111, 0o111);
    assert.equal(fs.statSync(sourceBuild).mode & 0o111, 0o111);
    assert.deepEqual(fixNodePtyPermissions(root, 'linux'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
