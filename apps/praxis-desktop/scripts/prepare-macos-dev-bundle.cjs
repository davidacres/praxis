#!/usr/bin/env node
'use strict';

// A custom-protocol cargo build needs an app bundle for macOS to find its Dock icon.
const fs = require('node:fs');
const path = require('node:path');
const desktop = path.resolve(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(desktop, 'src-tauri/tauri.conf.json'), 'utf8'));
const binary = path.resolve(process.argv[2]);
const contents = path.join(path.dirname(binary), 'Praxis.app', 'Contents');
const executable = path.join(contents, 'MacOS', 'praxis-desktop');
const resources = path.join(contents, 'Resources');
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.mkdirSync(resources, { recursive: true });
fs.copyFileSync(binary, executable);
fs.chmodSync(executable, 0o755);
fs.copyFileSync(path.join(desktop, 'src-tauri/icons/icon.icns'), path.join(resources, 'icon.icns'));
const escapeXml = value => String(value).replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]);
const values = {
  CFBundleExecutable: 'praxis-desktop',
  CFBundleIdentifier: config.identifier,
  CFBundleName: config.productName,
  CFBundleDisplayName: config.productName,
  CFBundlePackageType: 'APPL',
  CFBundleIconFile: 'icon.icns',
  CFBundleShortVersionString: config.version,
  CFBundleVersion: config.version,
};
fs.writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${Object.entries(values).map(([key, value]) => `<key>${key}</key><string>${escapeXml(value)}</string>`).join('\n')}
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
process.stdout.write(executable);
