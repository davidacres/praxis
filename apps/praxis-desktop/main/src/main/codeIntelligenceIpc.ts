import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { codeIntelligenceDataDirectory, type CodeIntelligenceOwnerStatus, type CodeIntelligenceRequest, type CodeIntelligenceResponse, type McpServerConfig, type SemanticModelStatus } from '@praxis/core';
import { sessionCodeIntelligenceServer } from './codeIntelligenceSession';
import { cleanupRemovedWorktreeIndexes } from './codeIntelligenceCleanup';
import { trustedIpcMain as ipcMain } from './trustedIpcMain.js';
import { getSettingsBackend, getSharedSettingsFilePath } from './settingsBackendInstance.js';
import {
  getSemanticModelDirectory,
  isSemanticModelInstalled,
  getSemanticModelStatus,
  downloadSemanticModel,
  deleteSemanticModel,
  getCachedFingerprint,
  setCachedFingerprint
} from './semanticModelManager.js';

const ACTIONS = new Set(['list', 'register', 'index', 'rebuild', 'relocate', 'pause', 'resume', 'unregister', 'query', 'connect', 'revoke', 'model-install', 'model-activate', 'owner-status', 'owner-start', 'owner-stop', 'owner-restart', 'cleanup']);
const TOOLS = new Set(['search_code', 'find_symbol', 'get_symbol', 'get_source', 'explain_symbol', 'get_callers', 'get_callees', 'trace_flow', 'find_related', 'summarize_project', 'get_index_status', 'search_knowledge', 'get_knowledge_section', 'find_related_knowledge']);

function dataDirectory(): string {
  if (!process.env.PRAXIS_CODE_INTELLIGENCE_DATA_DIRECTORY && process.env.PRAXIS_SETTINGS_PATH)
    return path.join(path.dirname(process.env.PRAXIS_SETTINGS_PATH), 'code-intelligence');
  return codeIntelligenceDataDirectory();
}

function service(): { executable: string; assembly?: string; contracts: string } {
  const native = process.env.PRAXIS_CODE_INTELLIGENCE_EXE || (app.isPackaged ? path.join(process.resourcesPath, 'code-intelligence', `Praxis.CodeIntelligence${process.platform === 'win32' ? '.exe' : ''}`) : undefined);
  if (native) {
    if (!existsSync(native)) throw new Error('Code intelligence service is not installed.');
    return { executable: native, contracts: path.join(path.dirname(native), 'contracts.json') };
  }
  const assembly = process.env.PRAXIS_CODE_INTELLIGENCE_DLL || path.resolve(__dirname, '../../../../../services/code-intelligence/src/Praxis.CodeIntelligence/bin/Debug/net10.0/Praxis.CodeIntelligence.dll');
  if (!existsSync(assembly)) throw new Error('Build the code intelligence service with npm run build:code-intelligence.');
  return { executable: process.env.PRAXIS_DOTNET || 'dotnet', assembly, contracts: path.join(path.dirname(assembly), 'contracts.json') };
}

function text(value: unknown, maximum = 4096): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value.includes('\0')) throw new Error('Invalid code intelligence argument.');
  return value;
}
async function invoke(args: string[], input?: Record<string, unknown>): Promise<CodeIntelligenceResponse> {
  const runtime = service();
  return new Promise((resolve, reject) => {
    const child = execFile(runtime.executable, [...(runtime.assembly ? [runtime.assembly] : []), ...args, '--data', dataDirectory()],
      { windowsHide: true, timeout: 125_000, maxBuffer: 128 * 1024, encoding: 'utf8' }, (_error, stdout, stderr) => {
        try { resolve(JSON.parse(stdout) as CodeIntelligenceResponse); } catch {
          // The CLI reports failures it cannot express as JSON (such as an owner that will
          // not start) on stderr; keep its first line so the cause is visible.
          const reason = String(stderr ?? '').split(/\r?\n/).find(line => line.trim())?.trim().slice(0, 300);
          reject(new Error('Local code intelligence service could not complete this operation' + (reason ? `: ${reason}` : '.')));
        }
      });
    child.stdin?.on('error', () => { }); child.stdin?.end(input ? JSON.stringify(input) : undefined);
  });
}
// The installed model's fingerprint, installing the downloaded bundle into the service the
// first time this session needs it.
async function installedModelFingerprint(): Promise<string | undefined> {
  const cached = getCachedFingerprint();
  if (cached) return cached;
  if (!isSemanticModelInstalled()) return undefined;
  const installed = await invoke(['model-install', getSemanticModelDirectory()]);
  const fingerprint = (installed.data as Record<string, unknown> | undefined)?.fingerprint;
  if (typeof fingerprint !== 'string') return undefined;
  setCachedFingerprint(fingerprint);
  return fingerprint;
}

async function registeredRepositoryIds(): Promise<string[]> {
  const listed = await invoke(['list']);
  return (Array.isArray(listed.data) ? listed.data as Array<Record<string, unknown>> : [])
    .map(repository => repository.id).filter((id): id is string => typeof id === 'string');
}

/**
 * Activates the model for each repository that has it neither active nor building, and
 * returns the failures. Vector search answers MODEL_UNAVAILABLE until a repository is
 * activated, so a dropped activation is invisible until someone searches; never discard
 * one. The service accepts an activation before the index is ready and builds the vectors
 * once it is.
 */
async function activateModel(fingerprint: string, repositoryIds: string[]): Promise<string[]> {
  const failures: string[] = [];
  for (const repositoryId of repositoryIds) {
    const status = await invoke(['local-rpc'], { tool: 'get_index_status', arguments: { repositoryId, responseBudgetTokens: 8000 } }).catch(() => undefined);
    const models = (status?.data as { models?: Array<{ fingerprint?: unknown; state?: unknown }> } | undefined)?.models ?? [];
    if (models.some(model => model.fingerprint === fingerprint && (model.state === 'active' || model.state === 'building'))) continue;
    const activated = await invoke(['model-activate', repositoryId, fingerprint])
      .catch((error: unknown) => ({ error: { code: 'OPERATION_FAILED', message: error instanceof Error ? error.message : String(error) } }));
    if (activated.error) failures.push(activated.error.message);
  }
  return failures;
}

/**
 * The background owner outlives the app, so a running one may hold an older build. Status
 * never starts it; start is any request (the CLI starts an owner on demand); stop waits for
 * it to exit. Restarting brings every client, agents' MCP bridges included, onto this build.
 */
async function ownerStatus(): Promise<CodeIntelligenceResponse> {
  const [status, version] = await Promise.all([invoke(['owner-status']), invoke(['version'])]);
  if (status.error) return status;
  const data = (status.data ?? {}) as CodeIntelligenceOwnerStatus;
  const currentBuild = (version.data as { build?: string } | undefined)?.build;
  return { data: { ...data, currentBuild, outdated: data.running === true && !!currentBuild && data.build !== currentBuild,
    // Whether anything was ever indexed here, so a caller can decide whether starting the service is worth it.
    hasIndex: existsSync(path.join(dataDirectory(), 'index.db')) } };
}
async function ownerStart(): Promise<CodeIntelligenceResponse> {
  const started = await invoke(['list']);
  return started.error ? started : ownerStatus();
}
async function ownerStop(): Promise<CodeIntelligenceResponse> {
  const stopped = await invoke(['stop']);
  return stopped.error ? stopped : ownerStatus();
}
async function ownerRestart(): Promise<CodeIntelligenceResponse> {
  const stopped = await invoke(['stop']);
  return stopped.error ? stopped : ownerStart();
}

/** On launch, replace an owner left running by an earlier build so the app never talks to old code. */
export async function replaceOutdatedOwner(): Promise<boolean> {
  const status = await ownerStatus();
  if (!(status.data as CodeIntelligenceOwnerStatus | undefined)?.outdated) return false;
  const restarted = await ownerRestart();
  if (restarted.error) throw new Error(restarted.error.message);
  return true;
}

/** Maintenance runs once after app readiness, against the current owner, without delaying startup. */
export async function maintainCodeIntelligenceOnStartup(): Promise<void> {
  await replaceOutdatedOwner();
  if (!existsSync(path.join(dataDirectory(), 'index.db'))) return;
  const removed = await cleanupRemovedWorktreeIndexes(invoke, (message, error) => console.warn(message, error));
  if (removed.length) console.info(`Unregistered ${removed.length} removed worktree code intelligence indexes.`);
}

// Repositories registered before this fix, or whose activation was refused while their
// index was failing, are caught up once per session.
let modelActivationCaughtUp = false;

export function registerCodeIntelligenceIpc(): void {
  ipcMain.handle('ai:codeIntelligence', async (_event, request: CodeIntelligenceRequest): Promise<CodeIntelligenceResponse> => {
    try {
      if (!request || !ACTIONS.has(request.action) || Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024) throw new Error('Invalid code intelligence request.');
      switch (request.action) {
        case 'list': return invoke(['list']);
        case 'cleanup': {
          const warnings: Array<{ code: string; message: string }> = [];
          const removed = await cleanupRemovedWorktreeIndexes(invoke, (message, error) => {
            console.warn(message, error);
            warnings.push({ code: 'CLEANUP_SKIPPED', message: `${message} ${error instanceof Error ? error.message : String(error)}` });
          });
          return { data: { removedCount: removed.length }, warnings };
        }
        case 'register': {
          const args = ['register', text(request.root)];
          if (request.manifest) args.push('--manifest', text(request.manifest));
          if (request.excludes?.length) { if (request.excludes.length > 100) throw new Error('Too many exclusions.'); args.push('--exclude', request.excludes.map(value => text(value)).join(';')); }
          const registered = await invoke(args);
          const repositoryId = (registered.data as Record<string, unknown> | undefined)?.repositoryId;
          if (registered.error || typeof repositoryId !== 'string') return registered;
          // A repository added after the model was installed needs it activated too.
          const fingerprint = await installedModelFingerprint().catch(() => undefined);
          const failures = fingerprint ? await activateModel(fingerprint, [repositoryId]) : [];
          return failures.length ? { ...registered, warnings: [...(registered.warnings ?? []), ...failures.map(message => ({ code: 'MODEL_ACTIVATION_FAILED', message }))] } : registered;
        }
        case 'relocate': {
          const args = ['relocate', text(request.repositoryId, 512), text(request.root)];
          if (request.manifest) args.push('--manifest', text(request.manifest));
          return invoke(args);
        }
        case 'query': {
          if (!TOOLS.has(text(request.tool, 64))) throw new Error('Unknown query tool.');
          if (!request.arguments || typeof request.arguments !== 'object' || Array.isArray(request.arguments)) throw new Error('Query arguments are required.');
          return invoke(['local-rpc'], { tool: request.tool, arguments: request.arguments });
        }
        case 'connect': {
          const repository = text(request.repositoryId, 512); const provider = text(request.provider, 128);
          const runtime = service(); if (!existsSync(runtime.contracts)) throw new Error('Code intelligence contracts are missing.');
          const grant = await invoke(['grant', repository, '--client', provider]); if (grant.error) return grant;
          const id = createHash('sha256').update(JSON.stringify([repository, provider])).digest('hex').slice(0, 24);
          const mcpServer: McpServerConfig = {
            id: `praxis-code-intelligence-${id}`, name: `Code intelligence ${id.slice(0, 8)}`, enabled: true, transport: 'stdio', requireApproval: true,
            command: process.execPath, args: [path.join(path.dirname(require.resolve('@praxis/core')), 'codeIntelligence', 'mcpBridge.js'), runtime.executable, runtime.assembly || '-', dataDirectory(), repository, provider, runtime.contracts],
            env: { ELECTRON_RUN_AS_NODE: '1', PRAXIS_CODE_INTELLIGENCE_PROVIDER: provider }
          };
          return { mcpServer };
        }
        case 'revoke': return invoke(['revoke', text(request.repositoryId, 512), '--client', text(request.provider, 128)]);
        case 'model-install': return invoke(['model-install', text(request.bundle)]);
        case 'model-activate': return invoke(['model-activate', text(request.repositoryId, 512), text(request.fingerprint, 71)]);
        case 'owner-status': return ownerStatus();
        case 'owner-start': return ownerStart();
        case 'owner-stop': return ownerStop();
        case 'owner-restart': return ownerRestart();
        default: return invoke([request.action, text(request.repositoryId, 512)]);
      }
    } catch (error) { return { error: { code: 'CAPABILITY_UNAVAILABLE', message: error instanceof Error ? error.message : 'Code intelligence is unavailable.' } }; }
  });

  ipcMain.handle('ai:getSemanticModelStatus', async (): Promise<SemanticModelStatus> => {
    try {
      const fingerprint = await installedModelFingerprint();
      if (fingerprint && !modelActivationCaughtUp) {
        modelActivationCaughtUp = true;
        const failures = await activateModel(fingerprint, await registeredRepositoryIds());
        if (failures.length) console.error('Semantic model activation failed:', failures.join('; '));
      }
    } catch (error) {
      console.error('Semantic model status check failed:', error);
    }
    return getSemanticModelStatus();
  });

  ipcMain.handle('ai:downloadSemanticModel', async (): Promise<SemanticModelStatus> => {
    await downloadSemanticModel();
    const installRes = await invoke(['model-install', getSemanticModelDirectory()]);
    // A downloaded model the service refused is not an installed one.
    if (installRes.error) throw new Error(`The local code intelligence service did not install the model: ${installRes.error.message}`);
    const fp = (installRes.data as Record<string, unknown>)?.fingerprint;
    if (typeof fp === 'string') {
      setCachedFingerprint(fp);
      const failures = await activateModel(fp, await registeredRepositoryIds());
      if (failures.length) throw new Error(`The model is installed but could not be activated: ${failures.join('; ')}`);
    }
    return getSemanticModelStatus();
  });

  ipcMain.handle('ai:deleteSemanticModel', async (): Promise<void> => {
    deleteSemanticModel();
  });

  ipcMain.handle('ai:resetCodeIntelligence', async (): Promise<void> => {
    deleteSemanticModel();

    const dataDir = dataDirectory();
    try {
      if (existsSync(dataDir)) {
        fs.rmSync(dataDir, { recursive: true, force: true });
        fs.mkdirSync(dataDir, { recursive: true });
      }
    } catch (err) {
      console.error('Failed to clear code intelligence data directory:', err);
    }

    try {
      const backend = getSettingsBackend();
      const current = backend.read();
      const cleanedServers = (current.ai.mcpServers ?? []).filter(
        (server: McpServerConfig) => !server.id.startsWith('praxis-code-intelligence-') && !server.env?.PRAXIS_CODE_INTELLIGENCE_PROVIDER
      );
      await backend.write({
        ai: {
          codeIntelligence: {
            enabled: true,
            projectOverrides: {}
          },
          mcpServers: cleanedServers
        }
      });
    } catch (err) {
      console.error('Failed to reset code intelligence settings:', err);
    }
  });
}

/**
 * Whether a session in this folder would get code intelligence tools — the same
 * settings rule `sessionCodeIntelligenceServer` applies, but read-only: it never
 * registers a folder or grants a client, so prompt feedback can ask on every keystroke.
 */
export function isCodeIntelligenceEnabledFor(workingDirectory: string | undefined): boolean {
  const config = getSettingsBackend().read().ai.codeIntelligence;
  const normalized = workingDirectory ? path.resolve(workingDirectory) : undefined;
  const override = normalized && workingDirectory
    ? config?.projectOverrides?.[normalized] ?? config?.projectOverrides?.[workingDirectory]
    : undefined;
  if (!(override ?? config?.enabled ?? true)) return false;
  try {
    return existsSync(service().contracts);
  } catch {
    return false;
  }
}

/**
 * Looks up identifiers by exact name in the folder's existing code index, for prompt
 * feedback. Read-only (no registration, no grant): an unindexed folder or a stopped
 * service yields `undefined`, and the caller treats the names as unchecked.
 */
export async function lookupIndexedSymbols(
  workingDirectory: string | undefined,
  names: readonly string[]
): Promise<Array<{ name: string; found: boolean; location?: string }> | undefined> {
  if (!workingDirectory || names.length === 0 || !isCodeIntelligenceEnabledFor(workingDirectory)) return undefined;
  const repositoryId = await indexedRepositoryId(workingDirectory);
  if (!repositoryId) return undefined;
  const results: Array<{ name: string; found: boolean; location?: string }> = [];
  for (const name of names.slice(0, 5)) {
    const key = `${repositoryId}\u0000${name}`;
    const cached = symbolLookupCache.get(key);
    if (cached && Date.now() - cached.at < SYMBOL_CACHE_TTL_MS) {
      results.push(cached.result);
      continue;
    }
    try {
      const response = await invoke(['local-rpc'], {
        tool: 'find_symbol',
        arguments: { repositoryId, name, limit: 1, freshness: 'allow_stale' }
      });
      if (response.error) return undefined;
      const item = ((response.data as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])[0];
      const location = typeof item?.qualifiedName === 'string' ? item.qualifiedName : undefined;
      const result = { name, found: Boolean(item), ...(location ? { location } : {}) };
      symbolLookupCache.set(key, { at: Date.now(), result });
      results.push(result);
    } catch {
      return undefined;
    }
  }
  return results;
}

const SYMBOL_CACHE_TTL_MS = 60_000;
const symbolLookupCache = new Map<string, { at: number; result: { name: string; found: boolean; location?: string } }>();
let repositoryListCache: { at: number; list: Array<Record<string, unknown>> } | undefined;

async function indexedRepositoryId(workingDirectory: string): Promise<string | undefined> {
  if (!repositoryListCache || Date.now() - repositoryListCache.at > SYMBOL_CACHE_TTL_MS) {
    try {
      const response = await invoke(['list']);
      repositoryListCache = { at: Date.now(), list: Array.isArray(response.data) ? (response.data as Array<Record<string, unknown>>) : [] };
    } catch {
      return undefined;
    }
  }
  const normalized = path.resolve(workingDirectory);
  // The folder itself, or the nearest indexed folder that contains it
  const match = repositoryListCache.list
    .filter(repo => typeof repo.root === 'string' && typeof repo.id === 'string')
    .filter(repo => normalized === path.resolve(repo.root as string) || normalized.startsWith(path.resolve(repo.root as string) + path.sep))
    .sort((a, b) => (b.root as string).length - (a.root as string).length)[0];
  return match?.id as string | undefined;
}

/** Code and knowledge tools for both folder-backed and folderless agent sessions. */
export async function getSessionCodeIntelligenceServer(
  workingDirectory: string | undefined,
  provider: string | undefined
): Promise<McpServerConfig | undefined> {
  return sessionCodeIntelligenceServer(workingDirectory, provider, {
    settings: getSettingsBackend().read().ai.codeIntelligence,
    settingsPath: getSharedSettingsFilePath(),
    runtime: service,
    nodeExecutable: process.execPath,
    bridgePath: path.join(path.dirname(require.resolve('@praxis/core')), 'codeIntelligence', 'mcpBridge.js'),
    dataDirectory: dataDirectory(),
    invoke,
    installedModelFingerprint,
    activateModel,
    warn: (message, error) => console.warn(message, error)
  });
}
