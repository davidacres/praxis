import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { codeIntelligenceDataDirectory, type CodeIntelligenceRequest, type CodeIntelligenceResponse, type McpServerConfig } from '@praxis/core';
import { trustedIpcMain as ipcMain } from './trustedIpcMain';

const ACTIONS = new Set(['list', 'register', 'index', 'pause', 'resume', 'unregister', 'query', 'connect', 'revoke', 'model-install', 'model-activate']);
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
}
