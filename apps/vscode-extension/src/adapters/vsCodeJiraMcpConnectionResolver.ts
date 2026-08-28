import * as vscode from 'vscode';
import { JiraMcpConnectionResolver as CoreJiraMcpConnectionResolver } from '@praxis/core';
import type { JiraMcpSettingsSource } from '@praxis/core';
import type { AppConfigStore } from '../config/jiraConfig';
import type { ConnectionType } from '@praxis/core';

export type { JiraMcpConnectionResolution } from '@praxis/core';

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

/** Reads the resolver's raw settings from the VS Code configuration tree. */
class VsCodeJiraMcpSettingsSource implements JiraMcpSettingsSource {
  private config(): ReturnType<typeof vscode.workspace.getConfiguration> {
    return vscode.workspace.getConfiguration('ticketManager');
  }

  public getConnectionType(): ConnectionType {
    return this.config().get<ConnectionType>('connectionType', 'stdio');
  }

  public getStdioCommand(): string {
    return this.config().get<string>('stdioCommand', '');
  }

  public getStdioArgs(): string[] {
    return this.config().get<string[]>('stdioArgs', []);
  }

  public getStdioCwd(): string {
    return this.config().get<string>('stdioCwd', '');
  }

  public getHttpUrl(): string {
    return this.config().get<string>('httpUrl', '');
  }

  public getWorkspaceMcpServerName(): string {
    return this.config().get<string>('workspaceMcpServerName', '');
  }

  public getUserMcpServerRef(): string {
    return this.config().get<string>('userMcpServerRef', '');
  }

  public getCustomEnv(): Record<string, string> {
    return loadCustomEnvFromConnections(this.config());
  }

  public getHttpHeaders(): Record<string, string> {
    return loadHttpHeadersFromConnections(this.config());
  }
}

/**
 * Extension-side adapter over the core resolver: keeps the original
 * constructor shape while sourcing settings from the VS Code configuration
 * and the workspace folder from `vscode.workspace.workspaceFolders`.
 */
export class JiraMcpConnectionResolver extends CoreJiraMcpConnectionResolver {
  public constructor(_context: vscode.ExtensionContext, configStore: AppConfigStore) {
    super(
      new VsCodeJiraMcpSettingsSource(),
      configStore,
      () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );
  }
}
