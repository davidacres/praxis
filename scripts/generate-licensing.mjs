// Regenerates the third-party inventory in LICENSING.md from the lockfiles.
//
//   node scripts/generate-licensing.mjs          rewrite the generated block
//   node scripts/generate-licensing.mjs --check  exit 1 if it is out of date
//
// Sources, all offline:
//   npm   package-lock.json, walked with Node's resolution from each shipped
//         workspace's production dependencies (dev-only packages never appear).
//   NuGet the code-intelligence service's packages.lock.json; licences come from
//         each package's .nuspec in the local NuGet cache.
//   pub   apps/praxis-mobile/pubspec.lock, walked from its "direct main"
//         dependencies through each package's pubspec.yaml in the pub cache.
// A package whose cache entry is missing is listed as "unknown (not in cache)",
// so --check is only meaningful after a restore on the machine running it.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'LICENSING.md');
const BEGIN = '<!-- licensing:generated:begin — run `npm run licenses`; do not edit by hand -->';
const END = '<!-- licensing:generated:end -->';

/** Licences that need no review for an MIT app: permissive, notice-only. */
const PERMISSIVE = new Set(['MIT', 'MIT-0', 'ISC', '0BSD', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0',
  'BlueOak-1.0.0', 'Python-2.0', 'PSF-2.0', 'Unicode-3.0', 'Unicode-DFS-2016', 'CC0-1.0', 'Zlib', 'BSL-1.0']);

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);

function detectLicenceText(text) {
  if (/Apache License[\s\S]{0,200}Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Mozilla Public License[\s\S]{0,40}2\.0/i.test(text)) return 'MPL-2.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(text)) return 'LGPL';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) return 'GPL';
  if (/Redistribution and use in source and binary forms/i.test(text))
    return /Neither the name|names of (its|their) contributors/i.test(text) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  return 'Other (see LICENSE)';
}

// ── npm ─────────────────────────────────────────────────────────────────────
function npmClosure() {
  const lock = readJson(path.join(root, 'package-lock.json')).packages;
  // Everything electron-builder packs (main + core + mobile packages) and
  // everything Vite bundles into the renderer.
  const workspaces = ['apps/praxis-desktop/main', 'apps/praxis-desktop/renderer', 'packages/core',
    'packages/mobile-protocol', 'packages/mobile-relay'];
  const found = new Map();
  // Node's lookup: the nearest node_modules walking up from the requiring package.
  const resolve = (from, name) => {
    for (let dir = from; ; dir = path.posix.dirname(dir)) {
      const key = (dir === '.' ? '' : dir + '/') + 'node_modules/' + name;
      if (lock[key]) return key;
      if (dir === '.') return undefined;
    }
  };
  const visit = (from, dependencies) => {
    for (const name of Object.keys(dependencies ?? {})) {
      const key = resolve(from, name);
      if (!key) continue; // an optional dependency not installed for this platform
      const entry = lock[key];
      if (entry.link || entry.dev) continue; // workspaces are walked as roots; dev never ships
      const id = name + '@' + entry.version;
      if (found.has(id)) continue;
      found.set(id, { name, version: entry.version, licence: entry.license ?? 'unknown' });
      visit(key, { ...entry.dependencies, ...entry.optionalDependencies });
    }
  };
  for (const workspace of workspaces) {
    const manifest = readJson(path.join(root, workspace, 'package.json'));
    visit(workspace, { ...manifest.dependencies, ...manifest.optionalDependencies });
  }
  return [...found.values()].sort(byName);
}

/** Shipped although declared as devDependencies: the runtime itself and the service's TypeScript sidecar. */
function npmShippedTools() {
  const lock = readJson(path.join(root, 'package-lock.json')).packages;
  return [['electron', 'Electron runtime (bundles Chromium and Node.js; their notices ship in LICENSES.chromium.html)'],
    ['typescript', 'copied into the code-intelligence package for the TypeScript sidecar']]
    .map(([name, note]) => ({ name, version: lock['node_modules/' + name]?.version ?? 'unknown', licence: lock['node_modules/' + name]?.license ?? 'unknown', note }));
}

// ── NuGet ───────────────────────────────────────────────────────────────────
function nugetPackages() {
  const lock = readJson(path.join(root, 'services/code-intelligence/src/Praxis.CodeIntelligence/packages.lock.json'));
  const cache = process.env.NUGET_PACKAGES || path.join(os.homedir(), '.nuget', 'packages');
  const found = new Map();
  for (const packages of Object.values(lock.dependencies))
    for (const [name, info] of Object.entries(packages)) {
      const id = name + '@' + info.resolved;
      if (found.has(id)) continue;
      const folder = path.join(cache, name.toLowerCase(), info.resolved.toLowerCase());
      const nuspec = path.join(folder, name.toLowerCase() + '.nuspec');
      let licence = 'unknown (not in cache)';
      if (existsSync(nuspec)) {
        const text = readFileSync(nuspec, 'utf8');
        const expression = text.match(/<license\s+type="expression">([^<]+)<\/license>/);
        const file = text.match(/<license\s+type="file">([^<]+)<\/license>/);
        const url = text.match(/<licenseUrl>([^<]+)<\/licenseUrl>/);
        if (expression) licence = expression[1].trim();
        else if (file && existsSync(path.join(folder, file[1]))) licence = detectLicenceText(readFileSync(path.join(folder, file[1]), 'utf8'));
        else if (url) licence = /licenses\.nuget\.org\/([^/<]+)/.exec(url[1])?.[1] ?? 'see ' + url[1];
      }
      found.set(id, { name, version: info.resolved, licence });
    }
  return [...found.values()].sort(byName);
}

// ── pub (Flutter) ───────────────────────────────────────────────────────────
function pubPackages() {
  const lockText = readFileSync(path.join(root, 'apps/praxis-mobile/pubspec.lock'), 'utf8');
  const cache = process.env.PUB_CACHE || path.join(os.homedir(), '.pub-cache');
  const packages = new Map();
  for (const block of lockText.split(/\n(?=  [A-Za-z0-9_]+:\n)/)) {
    const name = block.match(/^\s*([A-Za-z0-9_]+):\n/)?.[1];
    if (!name || name === 'packages') continue;
    packages.set(name, {
      dependency: block.match(/dependency: "([^"]+)"/)?.[1],
      source: block.match(/source: (\w+)/)?.[1],
      version: block.match(/version: "([^"]+)"/)?.[1] ?? ''
    });
  }
  const folderOf = (name, info) => path.join(cache, 'hosted', 'pub.dev', name + '-' + info.version);
  const dependenciesOf = (name, info) => {
    const pubspec = path.join(folderOf(name, info), 'pubspec.yaml');
    if (!existsSync(pubspec)) return [];
    const section = readFileSync(pubspec, 'utf8').match(/^dependencies:\n((?:[ \t].*\n|\n)*)/m)?.[1] ?? '';
    return [...section.matchAll(/^  ([A-Za-z0-9_]+):/gm)].map(match => match[1]);
  };
  const found = new Map();
  const visit = name => {
    const info = packages.get(name);
    if (!info || found.has(name)) return;
    let licence = 'unknown (not in cache)';
    if (info.source === 'sdk') licence = 'BSD-3-Clause';
    else {
      const folder = folderOf(name, info);
      const file = existsSync(folder) && readdirSync(folder).find(entry => /^LICEN[CS]E/i.test(entry));
      if (file) licence = detectLicenceText(readFileSync(path.join(folder, file), 'utf8'));
    }
    found.set(name, { name, version: info.source === 'sdk' ? 'SDK' : info.version, licence });
    for (const dependency of dependenciesOf(name, info)) visit(dependency);
  };
  for (const [name, info] of packages) if (info.dependency === 'direct main') visit(name);
  return [...found.values()].sort(byName);
}

// ── Render ──────────────────────────────────────────────────────────────────
function table(rows, withNote = false) {
  const head = withNote ? '| Package | Version | Licence | Why it ships |\n| --- | --- | --- | --- |' : '| Package | Version | Licence |\n| --- | --- | --- |';
  return [head, ...rows.map(row => `| \`${row.name}\` | ${row.version} | ${row.licence} |${withNote ? ` ${row.note} |` : ''}`)].join('\n');
}

function summary(groups) {
  const counts = new Map();
  for (const rows of groups) for (const row of rows) counts.set(row.licence, (counts.get(row.licence) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([licence, count]) => `${licence} ${count}`).join(' · ');
}

const npm = npmClosure(), tools = npmShippedTools(), nuget = nugetPackages(), pub = pubPackages();
const review = [...npm, ...tools, ...nuget, ...pub].filter(row => !PERMISSIVE.has(row.licence));
const generated = [BEGIN, '',
  `Totals: ${npm.length + tools.length} npm, ${nuget.length} NuGet, ${pub.length} pub. By licence: ${summary([npm, tools, nuget, pub])}.`, '',
  review.length
    ? '**Needs review** (not on the permissive list in `scripts/generate-licensing.mjs`):\n\n' + table(review)
    : '**Needs review:** nothing — every shipped package is on the permissive list.', '',
  '### Desktop app — npm packages in the installer', '',
  'Production dependencies of `@praxis/desktop-main`, `@praxis/core` and the mobile protocol/relay packages, plus everything bundled into the renderer.', '',
  table(npm), '',
  '### Desktop app — shipped tools', '',
  table(tools, true), '',
  '### Code intelligence service — NuGet packages', '',
  'Published self-contained, so the .NET runtime (MIT) ships too.', '',
  table(nuget), '',
  '### Phone app — pub packages', '',
  'Runtime dependencies of `apps/praxis-mobile` (dev dependencies excluded). SDK packages are part of Flutter (BSD-3-Clause).', '',
  table(pub), '', END].join('\n');

const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
const start = current.indexOf(BEGIN), end = current.indexOf(END);
if (start < 0 || end < 0) { console.error('LICENSING.md has no generated block markers.'); process.exit(1); }
const next = current.slice(0, start) + generated + current.slice(end + END.length);
if (process.argv.includes('--check')) {
  if (next !== current) { console.error('LICENSING.md is out of date; run `npm run licenses`.'); process.exit(1); }
  console.log('LICENSING.md is up to date.');
} else {
  writeFileSync(target, next);
  console.log(`LICENSING.md: ${npm.length + tools.length} npm, ${nuget.length} NuGet, ${pub.length} pub; ${review.length} need review.`);
}
