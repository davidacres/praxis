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
//   --model <folder>  model bundle to install and activate (default: the desktop's download, if present)
import { execFile, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
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
const printOnly = flag('--no-mcp'); const disconnect = flag('--disconnect'); const list = flag('--list');
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
const model = modelOption ?? process.env.PRAXIS_MODEL_BUNDLE ?? (existsSync(path.join(desktopModel, 'manifest.json')) ? desktopModel : undefined);
if (model && state !== 'ready') console.log('Run connect again once indexing finishes to activate the semantic model.');
else if (model) {
  const { fingerprint } = await call('model-install', model);
  const status = await call('status', repositoryId);
  if ((status?.models ?? []).some(entry => entry.fingerprint === fingerprint && entry.state === 'active')) console.log('Semantic model already active.');
  else { await call('model-activate', repositoryId, fingerprint); console.log('Semantic model activated; vectors build in the background.'); }
} else console.log('No semantic model found, so search is keyword-only. Download it in Praxis (Code intelligence page) or pass --model <bundle>.');

// `node` from PATH survives Node upgrades; a versioned install path (Homebrew's Cellar) does not.
const node = spawnSync('node', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0 ? 'node' : process.execPath;
const add = ['mcp', 'add', '--scope', 'user', MCP_NAME, '--', node, bridge, executable, '-', data, '*', client, contracts];
// Quote anything the shell would interpret: the bridge's '*' would otherwise expand as a glob.
const quoted = ['claude', ...add].map(part => /^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`).join(' ');
const claudeAvailable = !printOnly && spawnSync('claude', ['--version'], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0;
if (!claudeAvailable) console.log(`\nAdd the MCP server to Claude Code once (it serves every granted repository):\n  ${quoted}`);
else if (spawnSync('claude', ['mcp', 'get', MCP_NAME], { stdio: 'ignore', shell: process.platform === 'win32' }).status === 0)
  console.log(`Claude Code already has the ${MCP_NAME} MCP server; it picks up this repository automatically.`);
else {
  const added = spawnSync('claude', add, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (added.status !== 0) fail(`claude mcp add failed. Run it yourself:\n  ${quoted}`);
  console.log(`Added the ${MCP_NAME} MCP server to Claude Code (user scope).`);
}
const name = repositoryNames(await call('grants', '--client', client)).find(entry => entry.repositoryId === repositoryId)?.name;
console.log(`\nIn Claude Code the repository is named "${name}" (see the list_repositories tool).`);
