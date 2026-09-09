/**
 * The `direct-process` deployment executor (FX-BE-059 / TASK-156).
 *
 * Spawns a project's own `LocalProcessTargetRef.executable` — an explicit,
 * reviewed deployment script the project checked in — with its configured
 * argument array, a scoped `cwd`, and typed inputs (the published artifact's
 * path, and whatever else the caller supplies) passed as environment
 * variables. `shell: false` throughout means an argument or an input value
 * is a literal byte string handed straight to `execve`; a path containing
 * spaces, quotes, `;`, `&&`, `$(...)`, or backticks is never parsed as shell
 * syntax, because nothing here ever builds a command string to parse. This
 * is the whole of "pass artifact/target inputs without command-string
 * interpolation" — there is no interpolation, by construction.
 *
 * `operationId` is supplied by the caller rather than generated here, and is
 * echoed back verbatim in every result — success, non-zero exit, a startup
 * failure that never obtained a pid, a timeout, or a cancellation. This is
 * "persist operation identity before dispatch" (TASK-154) made concrete for
 * this executor: a caller is expected to mint and durably record the id
 * *before* calling `runDirectProcessDeployment`, so a crash mid-dispatch
 * still leaves a record of what was attempted; this function's only
 * obligation is to never lose or replace that id on any path, including
 * ones where the process itself never started.
 *
 * Process lifecycle (spawn, bounded output capture, timeout, cancellation,
 * cross-platform tree kill) mirrors `workflows/workflowCheckProcess.ts`'s
 * `spawnCheck` (main process) and reuses `host/processTree.ts`'s
 * `killProcessTree`, the same helper `projects/runServiceManager.ts` uses —
 * three independent spawn-and-wait call sites now share one kill-tree
 * implementation rather than three copies of it.
 */

import { spawn } from 'node:child_process';
import { killProcessTree } from '../host/processTree';

/** Bytes of combined stdout+stderr retained; oldest is dropped first, matching `workflowCheckProcess.ts`'s own bound. */
const MAX_OUTPUT_BYTES = 200_000;

export interface DirectProcessDeploymentInput {
  /**
   * Caller-assigned identity for this dispatch attempt, echoed back verbatim
   * in the result on every path. Mint and persist this *before* calling —
   * see the module doc.
   */
  operationId: string;
  executable: string;
  args?: string[];
  /** Must already be resolved to an absolute path; this function does no path resolution of its own. */
  cwd: string;
  /**
   * Typed inputs the script receives as environment variables, name
   * `PRAXIS_DEPLOY_<key>` — e.g. `{ ARTIFACT_PATH: artifact.location.path }`
   * surfaces as `process.env.PRAXIS_DEPLOY_ARTIFACT_PATH` in the script,
   * byte-identical to the value given here, spaces and shell metacharacters
   * included, because an environment variable is never shell-parsed.
   */
  inputs?: Record<string, string>;
  /** Additional environment beyond the inherited process env and `inputs`. */
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DirectProcessDeploymentResult {
  operationId: string;
  /** Present once the process actually spawned; absent for a startup failure that never obtained one. */
  pid?: number;
  /** `null` when the process never produced an exit code — a startup failure, or a forceful kill on some platforms. */
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  /** Bounded combined stdout+stderr, oldest truncated first. */
  output: string;
  startedAt: string;
  endedAt: string;
  error?: string;
}

const INPUT_ENV_PREFIX = 'PRAXIS_DEPLOY_';

export function runDirectProcessDeployment(input: DirectProcessDeploymentInput): Promise<DirectProcessDeploymentResult> {
  const startedAt = new Date().toISOString();

  if (input.signal?.aborted) {
    return Promise.resolve({
      operationId: input.operationId,
      exitCode: null,
      timedOut: false,
      cancelled: true,
      output: '',
      startedAt,
      endedAt: new Date().toISOString(),
      error: 'Deployment cancelled before it started.'
    });
  }

  return new Promise(resolve => {
    let output = '';
    let timedOut = false;
    let cancelled = false;
    let stopping = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let settled = false;

    const inputEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.inputs ?? {})) {
      inputEnv[`${INPUT_ENV_PREFIX}${key}`] = value;
    }

    const child = spawn(input.executable, input.args ?? [], {
      cwd: input.cwd,
      shell: false,
      detached: process.platform !== 'win32',
      env: { ...process.env, ...input.env, ...inputEnv }
    });

    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      void killProcessTree(child, false);
      forceTimer = setTimeout(() => void killProcessTree(child, true), 1_000);
    };

    if (input.timeoutMs) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        stop();
      }, input.timeoutMs);
    }

    const onAbort = (): void => {
      cancelled = true;
      stop();
    };
    input.signal?.addEventListener('abort', onAbort, { once: true });

    const collect = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-MAX_OUTPUT_BYTES);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const cleanup = (): void => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceTimer) clearTimeout(forceTimer);
      input.signal?.removeEventListener('abort', onAbort);
      // Descendants can close their inherited pipes and outlive the leader.
      if (stopping) void killProcessTree(child, true);
    };

    const finish = (result: Omit<DirectProcessDeploymentResult, 'operationId' | 'startedAt' | 'endedAt'>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ operationId: input.operationId, startedAt, endedAt: new Date().toISOString(), ...result });
    };

    child.once('error', error => {
      finish({
        pid: child.pid,
        exitCode: null,
        timedOut,
        cancelled,
        output,
        error: `Could not start ${input.executable}: ${error.message}`
      });
    });
    child.once('close', code => {
      finish({
        pid: child.pid,
        exitCode: code,
        timedOut,
        cancelled,
        output,
        ...(timedOut ? { error: `Deployment script timed out after ${input.timeoutMs}ms.` } : {}),
        ...(cancelled && !timedOut ? { error: 'Deployment cancelled.' } : {})
      });
    });
  });
}
