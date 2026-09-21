const fs = require('node:fs');
const path = require('node:path');

/**
 * node-pty 1.1.0's macOS prebuild contains a separate spawn-helper binary, but
 * npm installs it without an executable bit. The addon still loads, then every
 * terminal creation fails at runtime with the unhelpful "posix_spawnp failed".
 */
function fixNodePtyPermissions(packageRoot, platform = process.platform) {
  if (platform !== 'darwin') return [];

  const candidates = [path.join(packageRoot, 'build', 'Release', 'spawn-helper')];
  const prebuilds = path.join(packageRoot, 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    for (const directory of fs.readdirSync(prebuilds)) {
      if (directory.startsWith('darwin-')) candidates.push(path.join(prebuilds, directory, 'spawn-helper'));
    }
  }

  const repaired = [];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const mode = fs.statSync(candidate).mode;
    if ((mode & 0o111) === 0o111) continue;
    fs.chmodSync(candidate, mode | 0o111);
    repaired.push(candidate);
  }
  return repaired;
}

if (require.main === module) {
  const packageRoot = path.dirname(require.resolve('node-pty/package.json'));
  const repaired = fixNodePtyPermissions(packageRoot);
  if (repaired.length) console.log(`Made ${repaired.length} node-pty spawn helper(s) executable.`);
}

module.exports = { fixNodePtyPermissions };
