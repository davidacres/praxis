import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

export type ProviderPreflightStatus = 'unavailable' | 'denied' | 'failed' | 'ready';

/** A stable subset of the ACP initialize response retained for orchestration decisions. */
export interface ProviderCapabilityManifest {
  protocol: 'acp';
  sessionResume: boolean;
  sessionLoad: boolean;
  sessionClose: boolean;
  mcpHttp: boolean;
}

/** Cheap, non-interactive check of whether a local CLI can run. */
export interface ProviderPreflightState {
  status: ProviderPreflightStatus;
  /** Human-readable diagnostic suitable for provider settings. */
  message: string;
  /** Parsed from `--version` when the CLI publishes a conventional version string. */
  providerVersion?: string;
}

/** Full preflight result, including the capabilities negotiated through ACP. */
export interface ProviderCapabilityProbe extends ProviderPreflightState {
  capabilities?: ProviderCapabilityManifest;
}

export type CliSpawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

const VERSION_TIMEOUT_MS = 5_000;

function versionFrom(output: string): string | undefined {
  return output.match(/\b(?:v(?:ersion)?\s*)?(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)\b/i)?.[1];
}

function denied(output: string): boolean {
  return /\b(permission denied|access denied|not authorized|unauthorized|forbidden|login required)\b/i.test(output);
}

/**
 * Runs only a local `--version` command. It neither starts ACP nor sends a
 * prompt, so it is safe to use while rendering provider availability.
 */
export function probeCliProvider(
  command: string,
  spawnProcess: CliSpawn = spawn,
  timeoutMs = VERSION_TIMEOUT_MS
): Promise<ProviderPreflightState> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      child = spawnProcess(command, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({ status: 'unavailable', message });
      return;
    }

    let settled = false;
    let output = '';
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ProviderPreflightState): void => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };

    child.stdout?.on('data', chunk => {
      output += String(chunk);
    });
    child.stderr?.on('data', chunk => {
      output += String(chunk);
    });
    child.once('error', error => {
      const message = error instanceof Error ? error.message : String(error);
      finish({
        status: (error as NodeJS.ErrnoException).code === 'EACCES' ? 'denied' : 'unavailable',
        message
      });
    });
    child.once('close', code => {
      const message = output.trim();
      if (code === 0) {
        finish({
          status: 'ready',
          message: message || 'CLI is available.',
          ...(versionFrom(message) ? { providerVersion: versionFrom(message) } : {})
        });
        return;
      }
      finish({
        status: denied(message) ? 'denied' : 'failed',
        message: message || `CLI exited with status ${code ?? 'unknown'}.`
      });
    });
    timeout = setTimeout(() => {
      child.kill();
      finish({ status: 'failed', message: `CLI version check timed out after ${timeoutMs}ms.` });
    }, timeoutMs);
  });
}
