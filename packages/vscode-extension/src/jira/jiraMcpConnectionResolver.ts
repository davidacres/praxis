import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parse as parseJsonc } from 'jsonc-parser';
import type { AppConfigStore } from '../config/jiraConfig';
import type {
  ConnectionConfig,
  ConnectionSource,
  HttpConnectionConfig,
  StdioConnectionConfig
} from '../types';

export interface JiraMcpConnectionResolution {
  config: ConnectionConfig;        // StdioConnectionConfig | HttpConnectionConfig
  source: ConnectionSource | 'legacySetting';
  description: string;
}

interface ParsedMcpServer {
  command: string;
  args: string[];
  cwd?: string;
}

const MIN_TIMEOUT_MS = 5000;

/** Returns true when a server name or its args indicate a Jira MCP server. */
function isJiraLike(serverName: string, rawArgs: unknown): boolean {
  if (serverName.toLowerCase().includes('jira')) {
    return true;
  }
  if (Array.isArray(rawArgs)) {
    const argsStr = rawArgs
      .filter((a): a is string => typeof a === 'string')
      .join(' ')
      .toLowerCase();
    if (argsStr.includes('jira')) {
      return true;
    }
  }
  return false;
}

function clampTimeout(timeoutMs: number): number {
  return Math.max(timeoutMs, MIN_TIMEOUT_MS);
}

/**
 * Reads a JSONC mcp.json file and returns the servers map, trying both
 * the VS Code draft (`servers`) and the shipped (`mcpServers`) key.
 * Returns undefined on any file/parse error rather than throwing.
 */
async function readMcpServers(
  filePath: string
): Promise<Record<string, ParsedMcpServer> | undefined> {
  try {
    const rawText = await fs.readFile(filePath, 'utf8');
    const parsed = parseJsonc(rawText, [], { allowTrailingComma: true });
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const obj = parsed as Record<string, unknown>;
    const serversRaw =
      (obj['servers'] ?? obj['mcpServers']) as
        | Record<string, { command?: unknown; args?: unknown; cwd?: unknown }>
        | undefined;
    if (!serversRaw || typeof serversRaw !== 'object') {
      return undefined;
    }
    const result: Record<string, ParsedMcpServer> = {};
    for (const [name, raw] of Object.entries(serversRaw)) {
      if (typeof raw !== 'object' || raw === null) {
        continue;
      }
      const command =
        typeof raw.command === 'string' && raw.command.trim().length > 0
          ? raw.command.trim()
          : '';
      const args = Array.isArray(raw.args)
        ? raw.args.filter((a): a is string => typeof a === 'string')
        : [];
      result[name] = {
        command,
        args,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined
      };
    }
    return result;
  } catch {
    return undefined;
  }
}

export class JiraMcpConnectionResolver {
  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly configStore: AppConfigStore
  ) {}

  public async resolve(): Promise<JiraMcpConnectionResolution | undefined> {
    // 1. Legacy stdio
    const legacyStdio = await this.tryLegacyStdio();
    if (legacyStdio) {
      return legacyStdio;
    }

    // 2. Legacy HTTP
    const legacyHttp = this.tryLegacyHttp();
    if (legacyHttp) {
      return legacyHttp;
    }

    // 3. Workspace MCP discovery
    const workspaceResult = await this.resolveWorkspaceMcp();
    if (workspaceResult) {
      return workspaceResult;
    }

    // 4. User MCP discovery
    const userResult = await this.resolveUserMcp();
    if (userResult) {
      return userResult;
    }

    return undefined;
  }

  public async hasJiraMcpConfig(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('ticketManager');

    const connectionType = config.get<string>('connectionType', 'stdio') as 'stdio' | 'http';
    if (connectionType === 'stdio') {
      const cmd = config.get<string>('stdioCommand', '').trim();
      if (cmd.length > 0) {
        return true;
      }
    } else {
      const url = config.get<string>('httpUrl', '').trim();
      if (url.length > 0) {
        return true;
      }
    }

    const workspaceName = config.get<string>('workspaceMcpServerName', '').trim();
    if (workspaceName.length > 0) {
      const workspacePath = this.getWorkspaceMcpFilePath();
      if (workspacePath && (await this.userMcpFileHasJiraLikeServer(workspacePath, workspaceName))) {
        return true;
      }
    }

    const userRef = config.get<string>('userMcpServerRef', '').trim();
    const resolvedUserRef = userRef.length > 0 ? userRef : 'jira';
    const userPath = await this.getUserMcpFilePath();
    if (userPath && (await this.userMcpFileHasJiraLikeServer(userPath, resolvedUserRef))) {
      return true;
    }

    return false;
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  /**
   * Checks legacy `ticketManager.stdioCommand` settings and builds a
   * StdioConnectionConfig when a command is present.
   */
  private async tryLegacyStdio(): Promise<JiraMcpConnectionResolution | undefined> {
    const config = vscode.workspace.getConfiguration('ticketManager');
    const rawStdioCommand = config.get<string>('stdioCommand', '').trim();
    if (rawStdioCommand.length === 0) {
      return undefined;
    }

    const stdioArgs = config.get<string[]>('stdioArgs', []);
    const stdioCwd = config.get<string>('stdioCwd', '');
    const timeoutMs = clampTimeout(this.configStore.getRequestTimeoutMs());
    const customEnv = loadCustomEnvFromConnections(config);
    const env = Object.keys(customEnv).length > 0 ? customEnv : {};

    const result: StdioConnectionConfig = {
      type: 'stdio',
      command: rawStdioCommand,
      args: stdioArgs.filter((arg): arg is string => typeof arg === 'string'),
      cwd: stdioCwd || undefined,
      timeoutMs,
      env
    };

    return { config: result, source: 'legacySetting' as ConnectionSource | 'legacySetting', description: 'Legacy stdio settings' };
  }

  /**
   * Checks legacy `ticketManager.httpUrl` and, if non-empty, builds an
   * HttpConnectionConfig. Headers are sourced from `connections` entries
   * whose settings contain `httpHeaders` or `headers`.
   */
  private tryLegacyHttp(): JiraMcpConnectionResolution | undefined {
    const config = vscode.workspace.getConfiguration('ticketManager');
    const httpUrl = config.get<string>('httpUrl', '').trim();
    if (httpUrl.length === 0) {
      return undefined;
    }

    const timeoutMs = clampTimeout(this.configStore.getRequestTimeoutMs());
    const headers = loadHttpHeadersFromConnections(config);

    const result: HttpConnectionConfig = {
      type: 'http',
      url: httpUrl,
      timeoutMs,
      headers
    };

    return { config: result, source: 'legacySetting' as ConnectionSource | 'legacySetting', description: 'Legacy HTTP settings' };
  }

  /**
   * Reads `.vscode/mcp.json` from the first workspace folder and picks the
   * server named `ticketManager.workspaceMcpServerName` (default `'jira'`).
   * A server is only considered usable when its name or args contain "jira".
   */
  private async resolveWorkspaceMcp(): Promise<JiraMcpConnectionResolution | undefined> {
    const config = vscode.workspace.getConfiguration('ticketManager');
    const serverNameRaw = config.get<string>('workspaceMcpServerName', '').trim();
    if (serverNameRaw.length === 0) {
      return undefined;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return undefined;
    }

    const mcpFilePath = path.join(
      workspaceFolder.uri.fsPath,
      '.vscode',
      'mcp.json'
    );

    const servers = await readMcpServers(mcpFilePath);
    if (!servers) {
      return undefined;
    }

    const targetName = serverNameRaw;
    const rawServer = servers[targetName];
    if (!rawServer || !rawServer.command) {
      return undefined;
    }

    if (!isJiraLike(targetName, rawServer.args)) {
      return undefined;
    }

    const timeoutMs = clampTimeout(this.configStore.getRequestTimeoutMs());
    const customEnv = loadCustomEnvFromConnections(config);

    const stdioConfig: StdioConnectionConfig = {
      type: 'stdio',
      command: rawServer.command,
      args: rawServer.args,
      cwd: rawServer.cwd,
      timeoutMs,
      env: customEnv
    };

    return {
      config: stdioConfig,
      source: 'workspaceMcp' as ConnectionSource,
      description: `Workspace MCP server "${targetName}" from .vscode/mcp.json`
    };
  }

  /**
   * Checks `JIRA_MINI_USER_MCP_PATHS` env var first; if set, parses that file.
   * Otherwise falls back to `~/.vscode/mcp.json`.
   * Picks the server named `ticketManager.userMcpServerRef` (default `'jira'`).
   */
  private async resolveUserMcp(): Promise<JiraMcpConnectionResolution | undefined> {
    const config = vscode.workspace.getConfiguration('ticketManager');
    const userRefRaw = config.get<string>('userMcpServerRef', '').trim();
    const targetName = userRefRaw.length > 0 ? userRefRaw : 'jira';

    const mcpFilePath = await this.getUserMcpFilePath();
    if (!mcpFilePath) {
      return undefined;
    }

    const servers = await readMcpServers(mcpFilePath);
    if (!servers) {
      return undefined;
    }

    const rawServer = servers[targetName];
    if (!rawServer || !rawServer.command) {
      return undefined;
    }

    if (!isJiraLike(targetName, rawServer.args)) {
      return undefined;
    }

    const timeoutMs = clampTimeout(this.configStore.getRequestTimeoutMs());
    const customEnv = loadCustomEnvFromConnections(config);

    const stdioConfig: StdioConnectionConfig = {
      type: 'stdio',
      command: rawServer.command,
      args: rawServer.args,
      cwd: rawServer.cwd,
      timeoutMs,
      env: customEnv
    };

    return {
      config: stdioConfig,
      source: 'userMcp' as ConnectionSource,
      description: `User MCP server "${targetName}" from ${mcpFilePath}`
    };
  }

  private getWorkspaceMcpFilePath(): string | undefined {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return undefined;
    }
    return path.join(workspaceFolder.uri.fsPath, '.vscode', 'mcp.json');
  }

  private async getUserMcpFilePath(): Promise<string | undefined> {
    const envPath = process.env['JIRA_MINI_USER_MCP_PATHS'];
    if (envPath && envPath.trim().length > 0) {
      return envPath.trim();
    }
    return path.join(os.homedir(), '.vscode', 'mcp.json');
  }

  private async userMcpFileHasJiraLikeServer(
    filePath: string,
    serverName: string
  ): Promise<boolean> {
    const servers = await readMcpServers(filePath);
    if (!servers) {
      return false;
    }
    const raw = servers[serverName];
    if (!raw || !raw.command) {
      return false;
    }
    return isJiraLike(serverName, raw.args);
  }
}

/**
 * Scans `ticketManager.connections` entries for `env` custom env vars and
 * merges them into a flat record. Returns an empty object when no entries
 * contribute any variables.
 */
function loadCustomEnvFromConnections(
  config: ReturnType<typeof vscode.workspace.getConfiguration>
): Record<string, string> {
  const raw = config.get<unknown[]>('connections', []);
  if (!Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const settings = (entry as Record<string, unknown>)['settings'];
    if (typeof settings !== 'object' || settings === null) {
      continue;
    }
    const env = (settings as Record<string, unknown>)['env'];
    if (typeof env === 'object' && env !== null && !Array.isArray(env)) {
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === 'string') {
          result[k] = v;
        }
      }
    }
  }
  return result;
}

/**
 * Scans `ticketManager.connections` entries for `httpHeaders` or `headers`
 * custom request headers and merges them. Returns an empty object when
 * no entries contribute any headers.
 */
function loadHttpHeadersFromConnections(
  config: ReturnType<typeof vscode.workspace.getConfiguration>
): Record<string, string> {
  const raw = config.get<unknown[]>('connections', []);
  if (!Array.isArray(raw)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const settings = (entry as Record<string, unknown>)['settings'];
    if (typeof settings !== 'object' || settings === null) {
      continue;
    }
    const headers =
      (settings as Record<string, unknown>)['httpHeaders'] ??
      (settings as Record<string, unknown>)['headers'];
    if (typeof headers === 'object' && headers !== null && !Array.isArray(headers)) {
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === 'string') {
          result[k] = v;
        }
      }
    }
  }
  return result;
}