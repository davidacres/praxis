#!/usr/bin/env node
// Connects a repository to code intelligence for a command-line agent in one step:
// register and index it, grant the client access, activate the semantic model when one is
// installed, and make sure the agent has the single all-repositories MCP server.
//
//   node services/code-intelligence/scripts/connect.mjs <folder> [options]
//   node services/code-intelligence/scripts/connect.mjs --disconnect <folder> [options]
//   node services/code-intelligence/scripts/connect.mjs --list [options]
//
// Options:
//   --client <name>   grant scope (default claude-cli)
//   --no-mcp          print the `claude mcp add` command instead of running it
//   --exe <path>      service executable (default $PRAXIS_CODE_INTELLIGENCE_EXE, then the local package)
//   --data <folder>   service data folder (default: the desktop's)
//   --model <folder>  model bundle to install and activate (default: the desktop's download,
//                     fetched from Hugging Face at the pinned revision when it is missing)
//   --no-download     never download the model; search stays keyword-only without one
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const MCP_NAME = 'code-intelligence';
const service = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repository = path.resolve(service, '../..');
const bridge = path.join(repository, 'packages/core/out/codeIntelligence/mcpBridge.js');
const contracts = path.join(service, 'contracts.json');
const run = promisify(execFile);

const args = process.argv.slice(2);
const option = name => { const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index + 1]; args.splice(index, 2); if (!value) fail(`${name} needs a value.`); return value; };
const flag = name => { const index = args.indexOf(name); if (index < 0) return false; args.splice(index, 1); return true; };
function fail(message) { console.error(message); process.exit(1); }

const client = option('--client') ?? 'claude-cli';
const executable = option('--exe') ?? process.env.PRAXIS_CODE_INTELLIGENCE_EXE ?? path.join(service, 'artifacts/package', `Praxis.CodeIntelligence${process.platform === 'win32' ? '.exe' : ''}`);
const load = createRequire(import.meta.url);
if (!existsSync(bridge)) fail('MCP bridge not built. Run: npm run build:core');
const data = option('--data') ?? load(path.join(repository, 'packages/core/out/codeIntelligence/runtimePaths.js')).codeIntelligenceDataDirectory();
const { repositoryNames } = load(bridge); // the names the bridge shows agents
const modelOption = option('--model');
const printOnly = flag('--no-mcp'); const noDownload = flag('--no-download'); const disconnect = flag('--disconnect'); const list = flag('--list');
if (!existsSync(executable)) fail(`Code intelligence service not found at ${executable}. Run: npm run package:code-intelligence`);

async function call(...command) {
  let stdout;
  try { ({ stdout } = await run(executable, [...command, '--data', data], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 })); }
  catch (error) { stdout = error.stdout; if (!stdout) fail(`${command[0]} failed: ${error.stderr?.trim() || error.message}`); }
  const response = JSON.parse(stdout);
  if (response.error) {
    // An owner started from an older build keeps serving until it exits and does not know newer actions.
    const hint = command[0] === 'grants' ? ' If Praxis or an older service build is running, quit it so the owner restarts on this build.' : '';
    fail(`${command[0]} failed: ${response.error.code}: ${response.error.message}${hint}`);
  }
  return response.data;
}
const canonical = folder => { try { return realpathSync(path.resolve(folder)); } catch { fail(`Folder not found: ${folder}`); } };
async function registered(folder) {
  const root = canonical(folder);
  return (await call('list')).find(entry => entry.root === root || canonical(entry.root) === root);
}
async function showGrants() {
  const granted = await call('grants', '--client', client);
  if (!granted.length) { console.log(`No repositories are granted to ${client}.`); return; }
  console.log(`Repositories granted to ${client}:`);
  const roots = new Map(granted.map(entry => [entry.repositoryId, entry.root]));
  for (const entry of repositoryNames(granted)) console.log(`  ${entry.name}  (${entry.state})  ${roots.get(entry.repositoryId)}`);
}

if (list) { await showGrants(); process.exit(0); }
const folder = args[0]; if (!folder || args.length > 1) fail('Usage: connect.mjs <folder> | --disconnect <folder> | --list  [--client name] [--no-mcp] [--exe path] [--data folder] [--model folder]');

if (disconnect) {
  const entry = await registered(folder); if (!entry) fail(`${folder} is not registered.`);
  await call('revoke', entry.id, '--client', client);
  console.log(`Revoked ${client} access to ${entry.root}. The index is kept; unregister it from Praxis to delete it.`);
  process.exit(0);
}

const { repositoryId } = await call('register', canonical(folder));
await call('grant', repositoryId, '--client', client);
console.log(`Registered ${canonical(folder)} and granted ${client} read access.`);
// Registration queues indexing in the owner; wait for it, since the model needs a ready index.
process.stdout.write('Indexing');
const deadline = Date.now() + 30 * 60_000; let state;
while ((state = (await call('list')).find(entry => entry.id === repositoryId)?.state) !== 'ready' && state !== 'paused' && Date.now() < deadline) {
  process.stdout.write('.'); await new Promise(resolve => setTimeout(resolve, 2000));
}
console.log(state === 'ready' ? ' done.' : ` still ${state}; it continues in the background.`);

// The desktop's model download; activation turns on hybrid (keyword + semantic) search.
const desktopModel = path.join(process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Application Support')
  : process.platform === 'win32' ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming')) : (process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config')),
  'Praxis', 'models', 'semantic-search');
// The service pins exactly one model; its manifest is the single source of truth.
const pinned = JSON.parse(readFileSync(path.join(service, 'models/bge-small-manifest.json'), 'utf8'));
const isPinned = folder => {
  try { const manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8')); return manifest.modelId === pinned.modelId && manifest.revision === pinned.revision; }
  catch { return false; }
};

// Same files, revision and checksums as the desktop download, into the same folder, so the
// desktop and this script share one copy. Written to a temporary folder and moved into place
// only after both checksums match; an older model in that folder (MiniLM) is replaced.
async function downloadPinnedModel(destination) {
  const staging = `${destination}.download-${process.pid}`;
  rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true });
  const assets = [
    { name: 'vocab.txt', remote: 'vocab.txt', sha256: pinned.vocabSha256 },
    { name: 'model.onnx', remote: 'onnx/model.onnx', sha256: pinned.modelSha256 }
  ];
  try {
    for (const asset of assets) {
      const response = await fetch(`https://huggingface.co/${pinned.modelId}/resolve/${pinned.revision}/${asset.remote}`);
      if (!response.ok || !response.body) throw new Error(`${asset.name}: HTTP ${response.status}`);
      const total = Number(response.headers.get('content-length')) || 0;
      const hash = createHash('sha256'); const file = createWriteStream(path.join(staging, asset.name));
      let received = 0; let shown = -1;
      for await (const chunk of response.body) {
        hash.update(chunk); received += chunk.length;
        if (!file.write(chunk)) await new Promise(resolve => file.once('drain', resolve));
        const percent = total ? Math.floor(received * 100 / total) : -1;
        if (process.stdout.isTTY && percent !== shown && percent % 5 === 0) { shown = percent; process.stdout.write(`\r  ${asset.name}: ${percent}% of ${(total / 1e6).toFixed(0)} MB`); }
      }
      await new Promise((resolve, reject) => file.end(error => (error ? reject(error) : resolve())));
      if (process.stdout.isTTY) process.stdout.write('\n');
      if (hash.digest('hex') !== asset.sha256) throw new Error(`${asset.name} does not match its pinned SHA-256`);
    }
    writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(pinned, null, 2));
    rmSync(destination, { recursive: true, force: true }); mkdirSync(path.dirname(destination), { recursive: true });
    renameSync(staging, destination);
  } catch (error) { rmSync(staging, { recursive: true, force: true }); throw error; }
}

let model = modelOption ?? process.env.PRAXIS_MODEL_BUNDLE ?? (isPinned(desktopModel) ? desktopModel : undefined);
if (!model && !noDownload) {
  console.log(`Downloading the semantic search model (${pinned.modelId}, about 133 MB, ${pinned.license}) …`);
  try { await downloadPinnedModel(desktopModel); model = desktopModel; console.log('  Verified against the pinned checksums.'); }
  catch (error) { console.log(`  Download failed: ${error.message}. Search stays keyword-only; run connect again to retry.`); }
}
if (model && state !== 'ready') console.log('Run connect again once indexing finishes to activate the semantic model.');
else if (model) {
  const { fingerprint } = await call('model-install', model);
  const status = await call('status', repositoryId);
  if ((status?.models ?? []).some(entry => entry.fingerprint === fingerprint && entry.state === 'active')) console.log('Semantic model already active.');
  else { await call('model-activate', repositoryId, fingerprint); console.log('Semantic model activated; vectors build in the background.'); }
} else if (noDownload) console.log('No semantic model, so search is keyword-only (--no-download). Download it in Praxis or run connect without --no-download.');

/**
 * Runs a CLI found on PATH. Windows needs a shell to run `claude.cmd` / `node.cmd`
 * shims, and `cmd.exe` gets one joined string, so each part is double-quoted
 * there: unquoted, a path with a space would split into two arguments.
 */
function runTool(command, args, stdio = 'ignore') {
  if (process.platform !== 'win32') return spawnSync(command, args, { stdio });
  const line = [command, ...args].map(part => `"${String(part).replaceAll('"', '""')}"`).join(' ');
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- every part is quoted above; Windows cannot run .cmd shims without a shell
  return spawnSync(line, { stdio, shell: true });
}

// `node` from PATH survives Node upgrades; a versioned install path (Homebrew's Cellar) does not.
const node = runTool('node', ['--version']).status === 0 ? 'node' : process.execPath;
const add = ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', node, bridge, executable, '-', data, '*', client, contracts];
// Quote anything the shell would interpret: the bridge's '*' would otherwise expand as a glob.
const quoted = ['claude', ...add].map(part => /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`).join(' ');
const claudeAvailable = !printOnly && runTool('claude', ['--version']).status === 0;
if (!claudeAvailable) console.log(`\nAdd the MCP server to Claude Code once (it serves every granted repository):\n  ${quoted}`);
else if (runTool('claude', ['mcp', 'get', MCP_NAME]).status === 0)
  console.log(`Claude Code already has the ${MCP_NAME} MCP server; it picks up this repository automatically.`);
else {
  const added = runTool('claude', add, 'inherit');
  if (added.status !== 0) fail(`claude mcp add failed. Run it yourself:\n  ${quoted}`);
  console.log(`Added the ${MCP_NAME} MCP server to Claude Code (user scope).`);
}
const name = repositoryNames(await call('grants', '--client', client)).find(entry => entry.repositoryId === repositoryId)?.name;
console.log(`\nIn Claude Code the repository is named "${name}" (see the list_repositories tool).`);
