import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import type { JiraConfigStore, JiraMcpSettingsSource } from './jiraConfigStore';
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

/**
 * Resolves how to reach a Jira MCP server, in priority order: legacy stdio
 * settings, legacy HTTP settings, a workspace `.vscode/mcp.json` server, then
 * a user-level mcp.json server. Host differences are injected: raw settings
 * come from a `JiraMcpSettingsSource`, and the workspace folder used for
 * `.vscode/mcp.json` discovery from `getWorkspaceFolderPath`.
 */
export class JiraMcpConnectionResolver {
  public constructor(
    private readonly settings: JiraMcpSettingsSource,
    private readonly configStore: Pick<JiraConfigStore, 'getRequestTimeoutMs'>,
    private readonly getWorkspaceFolderPath: () => string | undefined = () => undefined
  ) {}

  public async resolve(): Promise<JiraMcpConnectionResolution | undefined> {
    // 1. Legacy stdio
    const legacyStdio = this.tryLegacyStdio();
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
    if (this.settings.getConnectionType() === 'stdio') {
      if (this.settings.getStdioCommand().trim().length > 0) {
        return true;
      }
    } else if (this.settings.getHttpUrl().trim().length > 0) {
      return true;
    }

    const workspaceName = this.settings.getWorkspaceMcpServerName().trim();
    if (workspaceName.length > 0) {
      const workspacePath = this.getWorkspaceMcpFilePath();
      if (workspacePath && (await this.userMcpFileHasJiraLikeServer(workspacePath, workspaceName))) {
        return true;
      }
    }

    const userRef = this.settings.getUserMcpServerRef().trim();
    const resolvedUserRef = userRef.length > 0 ? userRef : 'jira';
    const userPath = await this.getUserMcpFilePath();
    if (userPath && (await this.userMcpFileHasJiraLikeServer(userPath, resolvedUserRef))) {
      return true;
    }

    return false;
  }

  // ── private helpers ─────────────────────────────────────────────────────────

  /**
   * Checks the legacy stdio settings and builds a StdioConnectionConfig when a
   * command is present.
   */
  private tryLegacyStdio(): JiraMcpConnectionResolution | undefined {
    const rawStdioCommand = this.settings.getStdioCommand().trim();
    if (rawStdioCommand.length === 0) {
      return undefined;
    }

    const stdioArgs = this.settings.getStdioArgs();
    const stdioCwd = this.settings.getStdioCwd();
    const timeoutMs = clampTimeout(this.configStore.getRequestTimeoutMs());

    const result: StdioConnectionConfig = {
      type: 'stdio',
      command: rawStdioCommand,
      args: stdioArgs.filter((arg): arg is string => typeof arg === 'string'),
      cwd: stdioCwd || undefined,
      timeoutMs,
      env: this.settings.getCustomEnv()
    };

    return { config: result, source: 'legacySetting', description: 'Legacy stdio settings' };
  }

  /**
   * Checks the legacy HTTP URL and, if non-empty, builds an
   * HttpConnectionConfig.
   */
  private tryLegacyHttp(): JiraMcpConnectionResolution | undefined {
    const httpUrl = this.settings.getHttpUrl().trim();
    if (httpUrl.length === 0) {
      return undefined;
    }

    const timeoutMs = clampTimeout(this.configStore.getRequestTimeoutMs());

    const result: HttpConnectionConfig = {
      type: 'http',
      url: httpUrl,
      timeoutMs,
      headers: this.settings.getHttpHeaders(),
      allowOAuth: this.settings.getHttpAllowOAuth?.() ?? true
    };

    return { config: result, source: 'legacySetting', description: 'Legacy HTTP settings' };
  }

  /**
   * Reads `.vscode/mcp.json` from the host-provided workspace folder and picks
   * the server named by `workspaceMcpServerName`. A server is only considered
   * usable when its name or args contain "jira".
   */
  private async resolveWorkspaceMcp(): Promise<JiraMcpConnectionResolution | undefined> {
    const targetName = this.settings.getWorkspaceMcpServerName().trim();
    if (targetName.length === 0) {
      return undefined;
    }

    const mcpFilePath = this.getWorkspaceMcpFilePath();
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

    const stdioConfig: StdioConnectionConfig = {
      type: 'stdio',
      command: rawServer.command,
      args: rawServer.args,
      cwd: rawServer.cwd,
      timeoutMs,
      env: this.settings.getCustomEnv()
    };

    return {
      config: stdioConfig,
      source: 'workspaceMcp',
      description: `Workspace MCP server "${targetName}" from .vscode/mcp.json`
    };
  }

  /**
   * Checks `JIRA_MINI_USER_MCP_PATHS` env var first; if set, parses that file.
   * Otherwise falls back to `~/.vscode/mcp.json`.
   * Picks the server named by `userMcpServerRef` (default `'jira'`).
   */
  private async resolveUserMcp(): Promise<JiraMcpConnectionResolution | undefined> {
    const userRefRaw = this.settings.getUserMcpServerRef().trim();
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

    const stdioConfig: StdioConnectionConfig = {
      type: 'stdio',
      command: rawServer.command,
      args: rawServer.args,
      cwd: rawServer.cwd,
      timeoutMs,
      env: this.settings.getCustomEnv()
    };

    return {
      config: stdioConfig,
      source: 'userMcp',
      description: `User MCP server "${targetName}" from ${mcpFilePath}`
    };
  }

  private getWorkspaceMcpFilePath(): string | undefined {
    const workspaceFolder = this.getWorkspaceFolderPath();
    if (!workspaceFolder) {
      return undefined;
    }
    return path.join(workspaceFolder, '.vscode', 'mcp.json');
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
