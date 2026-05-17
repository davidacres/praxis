import * as path from 'node:path';
import { existsSync } from 'node:fs';

const KNOWN_EDITOR_LAUNCHERS = new Set([
  'code',
  'code.exe',
  'code.cmd',
  'code.bat',
  'code-insiders',
  'code-insiders.exe',
  'code-insiders.cmd',
  'code-insiders.bat',
  'code - insiders',
  'code - insiders.exe',
  'cursor',
  'cursor.exe',
  'cursor.cmd',
  'cursor.bat',
  'cursor-insiders',
  'cursor-insiders.exe',
  'cursor-insiders.cmd',
  'cursor-insiders.bat',
  'cursor - insiders',
  'cursor - insiders.exe'
]);

export interface ResolvedCopilotCliOverride {
  cliPath?: string;
  warning?: string;
}

export interface ResolvedCopilotClientOptions {
  clientOptions: {
    cliPath?: string;
    cliArgs?: string[];
    env?: NodeJS.ProcessEnv;
  };
  warning?: string;
}

function basenameFromAnyPath(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]+/);
  return (parts[parts.length - 1] || trimmed).trim().toLowerCase();
}

export function resolveCopilotCliOverride(rawPath: string | undefined): ResolvedCopilotCliOverride {
  const trimmed = rawPath?.trim();
  if (!trimmed) {
    return {};
  }

  const basename = basenameFromAnyPath(trimmed);
  if (KNOWN_EDITOR_LAUNCHERS.has(basename)) {
    return {
      warning:
        'Ignoring ticketManager.ai.copilotCliPath because it points to an editor launcher rather than the GitHub Copilot SDK runtime. Clear that setting to use the SDK default runtime.'
    };
  }

  return { cliPath: trimmed };
}

function isJavaScriptEntrypoint(path: string | undefined): boolean {
  if (!path) {
    return false;
  }
  return /\.(?:c|m)?js$/i.test(path.trim());
}

function resolveBundledCopilotBinaryPath(): string | undefined {
  try {
    const candidate = require.resolve(`@github/copilot-${process.platform}-${process.arch}`);
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function resolveBundledCopilotCliPath(): string | undefined {
  const binaryPath = resolveBundledCopilotBinaryPath();
  if (binaryPath) {
    return binaryPath;
  }

  try {
    const sdkMainPath = require.resolve('@github/copilot-sdk');
    const githubScopeDir = path.dirname(path.dirname(path.dirname(path.dirname(sdkMainPath))));
    const candidate = path.join(githubScopeDir, 'copilot', 'npm-loader.js');
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function isElectronHostProcess(explicit: boolean | undefined): boolean {
  if (typeof explicit === 'boolean') {
    return explicit;
  }

  return Boolean(process.versions?.electron) || KNOWN_EDITOR_LAUNCHERS.has(basenameFromAnyPath(process.execPath));
}

export function resolveCopilotClientOptions(
  rawPath: string | undefined,
  options?: {
    isElectronHost?: boolean;
    env?: NodeJS.ProcessEnv;
  }
): ResolvedCopilotClientOptions {
  const { cliPath: overrideCliPath, warning } = resolveCopilotCliOverride(rawPath);
  const cliPath = overrideCliPath ?? resolveBundledCopilotCliPath();
  const isElectronHost = isElectronHostProcess(options?.isElectronHost);
  const baseEnv = options?.env ?? process.env;
  const clientOptions: ResolvedCopilotClientOptions['clientOptions'] = {};

  if (cliPath) {
    clientOptions.cliPath = cliPath;
  }

  // AUTOPILOT MODE — Ticket Manager sessions run with full permissions by
  // default. Pass --allow-all to the Copilot CLI so it never prompts for
  // shell/write/mcp/read/url/custom-tool permission, and include
  // --no-ask-user so the agent never tries to use the ask_user tool (which
  // surfaces as a popup). Also set COPILOT_ALLOW_ALL=1 as a belt-and-braces
  // environment-level override in case cliArgs is overridden by the host.
  clientOptions.cliArgs = ['--allow-all', '--no-ask-user'];

  // The SDK may spawn a JS entrypoint via process.execPath. Under Electron hosts
  // like VS Code/Cursor, that executable is Code.exe/Cursor.exe, so force it to
  // behave as Node for the spawned Copilot runtime.
  if (isElectronHost && (!cliPath || isJavaScriptEntrypoint(cliPath))) {
    clientOptions.env = {
      ...baseEnv,
      ELECTRON_RUN_AS_NODE: '1',
      COPILOT_ALLOW_ALL: '1'
    };
  } else {
    clientOptions.env = {
      ...baseEnv,
      COPILOT_ALLOW_ALL: '1'
    };
  }

  return {
    clientOptions,
    warning
  };
}
