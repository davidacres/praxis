const fs = require('node:fs');
const path = require('node:path');

// Keep internal workspace names stable; GitHub Packages requires the owning
// account's scope on the packages that leave the repository.
const root = path.resolve(__dirname, '../../../..');
const [output, scope, requestedVersion] = process.argv.slice(2);
const version = requestedVersion || require('../package.json').version;
if (!output || !/^[a-z0-9][a-z0-9-]*$/.test(scope || '') ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Usage: stagePublishedLibraries.cjs <output> <GitHub owner> [version]');
}

for (const library of ['core', 'mobile-protocol']) {
  const source = path.join(root, 'packages', library);
  const destination = path.join(output, library);
  if (!fs.existsSync(path.join(source, 'out', 'index.js')) ||
      !fs.existsSync(path.join(source, 'out', 'index.d.ts'))) {
    throw new Error(`Build ${library} before staging its package.`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(path.join(source, 'out'), path.join(destination, 'out'), { recursive: true });
  const { scripts, devDependencies, ...published } = manifest;
  fs.writeFileSync(path.join(destination, 'package.json'), JSON.stringify({
    ...published,
    name: `@${scope}/praxis-${library}`,
    version,
    license: 'MIT',
    files: ['out'],
    repository: { type: 'git', url: `https://github.com/${scope}/praxis.git`, directory: `packages/${library}` },
    publishConfig: { registry: 'https://npm.pkg.github.com' }
  }, null, 2) + '\n');
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'));
  console.log(`Staged @${scope}/praxis-${library}@${version}`);
}
