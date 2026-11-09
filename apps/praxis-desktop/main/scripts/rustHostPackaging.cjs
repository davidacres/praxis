'use strict';
const fs = require('node:fs');
const path = require('node:path');

const base = require('../package.json').build;
const folder = path.resolve(__dirname, '../dist/rust-host-staging');
const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'host.praxis.json'), 'utf8'));
if (manifest.platform !== process.platform || manifest.arch !== process.arch || manifest.profile !== 'release') {
  throw new Error('Rust candidate packaging requires a freshly staged native release host.');
}

// Separate candidate configuration: the normal release policy and delegate set are unchanged.
module.exports = {
  ...base,
  mac: { ...base.mac, notarize: false },
  beforePack: async context => {
    const arch = require('builder-util').Arch[context.arch];
    if (context.electronPlatformName !== manifest.platform || arch !== manifest.arch) {
      throw new Error('Cross-platform candidate packaging needs a matching native Rust host; refusing to bundle the wrong binary.');
    }
  },
  extraResources: [...base.extraResources, { from: folder, to: 'rust-host' }],
};
