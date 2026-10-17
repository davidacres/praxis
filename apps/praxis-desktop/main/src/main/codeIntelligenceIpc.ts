import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { codeIntelligenceDataDirectory, type CodeIntelligenceRequest, type CodeIntelligenceResponse, type McpServerConfig, type SemanticModelStatus } from '@praxis/core';
import { trustedIpcMain as ipcMain } from './trustedIpcMain.js';
import { getSettingsBackend } from './settingsBackendInstance.js';
import {
  getSemanticModelDirectory,
  isSemanticModelInstalled,
  getSemanticModelStatus,
  downloadSemanticModel,
  deleteSemanticModel,
  getCachedFingerprint,
  setCachedFingerprint
} from './semanticModelManager.js';

const ACTIONS = new Set(['list', 'register', 'index', 'rebuild', 'relocate', 'pause', 'resume', 'unregister', 'query', 'connect', 'revoke', 'model-install', 'model-activate']);
const TOOLS = new Set(['search_code', 'find_symbol', 'get_symbol', 'get_source', 'explain_symbol', 'get_callers', 'get_callees', 'trace_flow', 'find_related', 'summarize_project', 'get_index_status']);

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
      { windowsHide: true, timeout: 125_000, maxBuffer: 128 * 1024, encoding: 'utf8' }, (_error, stdout) => {
        try { resolve(JSON.parse(stdout) as CodeIntelligenceResponse); } catch { reject(new Error('Local code intelligence service could not complete this operation.')); }
      });
    child.stdin?.on('error', () => { }); child.stdin?.end(input ? JSON.stringify(input) : undefined);
  });
}
export function registerCodeIntelligenceIpc(): void {
  ipcMain.handle('ai:codeIntelligence', async (_event, request: CodeIntelligenceRequest): Promise<CodeIntelligenceResponse> => {
    try {
      if (!request || !ACTIONS.has(request.action) || Buffer.byteLength(JSON.stringify(request)) > 1024 * 1024) throw new Error('Invalid code intelligence request.');
      switch (request.action) {
        case 'list': return invoke(['list']);
        case 'register': {
          const args = ['register', text(request.root)];
          if (request.manifest) args.push('--manifest', text(request.manifest));
          if (request.excludes?.length) { if (request.excludes.length > 100) throw new Error('Too many exclusions.'); args.push('--exclude', request.excludes.map(value => text(value)).join(';')); }
          return invoke(args);
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
        default: return invoke([request.action, text(request.repositoryId, 512)]);
      }
    } catch (error) { return { error: { code: 'CAPABILITY_UNAVAILABLE', message: error instanceof Error ? error.message : 'Code intelligence is unavailable.' } }; }
  });

  ipcMain.handle('ai:getSemanticModelStatus', async (): Promise<SemanticModelStatus> => {
    const config = getSettingsBackend().read().ai.codeIntelligence;
    const customPath = config?.customModelPath;
    const configuredModelId = config?.modelId || 'sentence-transformers/all-MiniLM-L6-v2';
    const modelDir = getSemanticModelDirectory(customPath);

    if (isSemanticModelInstalled(customPath) && !getCachedFingerprint()) {
      try {
        const installRes = await invoke(['model-install', modelDir]);
        const fp = (installRes.data as Record<string, unknown>)?.fingerprint;
        if (typeof fp === 'string') setCachedFingerprint(fp);
      } catch {
        // ignore
      }
    }
    return getSemanticModelStatus(customPath, configuredModelId);
  });

  ipcMain.handle('ai:downloadSemanticModel', async (): Promise<SemanticModelStatus> => {
    const config = getSettingsBackend().read().ai.codeIntelligence;
    const customPath = config?.customModelPath;
    const configuredModelId = config?.modelId || 'sentence-transformers/all-MiniLM-L6-v2';
    const modelDir = getSemanticModelDirectory(customPath);

    await downloadSemanticModel(configuredModelId, customPath);
    const installRes = await invoke(['model-install', modelDir]);
    const fp = (installRes.data as Record<string, unknown>)?.fingerprint;
    if (typeof fp === 'string') {
      setCachedFingerprint(fp);
      try {
        const listRes = await invoke(['list']);
        const list = Array.isArray(listRes.data) ? (listRes.data as Array<Record<string, unknown>>) : [];
        for (const r of list) {
          if (typeof r.id === 'string') {
            void invoke(['model-activate', r.id, fp]).catch(() => {});
          }
        }
      } catch {
        // ignore
      }
    }
    return getSemanticModelStatus(customPath, configuredModelId);
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
 * Returns the code intelligence McpServerConfig for an agent session if enabled.
 * Auto-registers the repository folder and grants provider client access.
 */
export async function getSessionCodeIntelligenceServer(
  workingDirectory: string | undefined,
  provider: string | undefined
): Promise<McpServerConfig | undefined> {
  if (!workingDirectory || !provider) return undefined;
  try {
    const settings = getSettingsBackend().read();
    const config = settings.ai.codeIntelligence;
    const globalEnabled = config?.enabled ?? true;
    const normalizedDir = path.resolve(workingDirectory);
    const override = config?.projectOverrides?.[normalizedDir] ?? config?.projectOverrides?.[workingDirectory];
    const isEnabled = override !== undefined ? override : globalEnabled;
    if (!isEnabled) return undefined;

    const runtime = service();
    if (!existsSync(runtime.contracts)) return undefined;

    const listResponse = await invoke(['list']).catch(() => undefined);
    if (!listResponse || listResponse.error) return undefined;

    const list = Array.isArray(listResponse.data) ? (listResponse.data as Array<Record<string, unknown>>) : [];
    let repo = list.find(r => typeof r.root === 'string' && (path.resolve(r.root) === normalizedDir || r.root === workingDirectory));

    if (!repo) {
      const regResponse = await invoke(['register', workingDirectory]).catch(() => undefined);
      if (!regResponse || regResponse.error) return undefined;
      const repoId = (regResponse.data as Record<string, unknown>)?.repositoryId;
      if (typeof repoId !== 'string') return undefined;
      void invoke(['index', repoId]).catch(() => {});
      repo = { id: repoId, root: workingDirectory };
    }

    const repositoryId = String(repo.id);
    const fp = getCachedFingerprint();
    if (fp) {
      void invoke(['model-activate', repositoryId, fp]).catch(() => {});
    }
    const grant = await invoke(['grant', repositoryId, '--client', provider]).catch(() => undefined);
    if (!grant || grant.error) return undefined;

    const id = createHash('sha256').update(JSON.stringify([repositoryId, provider])).digest('hex').slice(0, 24);
    const mcpServer: McpServerConfig = {
      id: `praxis-code-intelligence-${id}`,
      name: `code_intelligence`,
      enabled: true,
      transport: 'stdio',
      requireApproval: false,
      command: process.execPath,
      args: [
        path.join(path.dirname(require.resolve('@praxis/core')), 'codeIntelligence', 'mcpBridge.js'),
        runtime.executable,
        runtime.assembly || '-',
        dataDirectory(),
        repositoryId,
        provider,
        runtime.contracts
      ],
      env: { ELECTRON_RUN_AS_NODE: '1', PRAXIS_CODE_INTELLIGENCE_PROVIDER: provider }
    };
    return mcpServer;
  } catch {
    return undefined;
  }
}

