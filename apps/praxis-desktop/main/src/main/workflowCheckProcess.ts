import { execFile, spawn } from 'node:child_process';
import type { WorkflowCheckNode } from '@praxis/core';
import { ensureEnvironmentPath } from './shellEnvironment';

export interface CheckProcessResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  error?: string;
}

/** Own the process tree until it has stopped, including on cancellation. */
export function spawnCheck(
  node: WorkflowCheckNode,
  cwd: string,
  signal?: AbortSignal,
  onLine?: (line: string) => void
): Promise<CheckProcessResult> {
  if (signal?.aborted) return Promise.resolve({ code: null, output: '', timedOut: false, error: 'Check cancelled.' });
  ensureEnvironmentPath();
  return new Promise(resolve => {
    let output = '';
    let timedOut = false;
    let stopping = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const inheritedCi = process.env.CI;
    const child = spawn(node.command, node.args ?? [], {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      // Workflow checks are unattended quality gates. CI semantics keep test runners non-interactive
      // while a local governed run can still use the Electron suite's normal four isolated workers.
      // Real CI remains serial, and an explicit worker choice always wins.
      env: {
        ...process.env,
        CI: inheritedCi ?? '1',
        ...(inheritedCi === undefined && process.env.PRAXIS_E2E_WORKERS === undefined
          ? { PRAXIS_E2E_WORKERS: '4' }
          : {})
      }
    });
    const killTree = (force: boolean): void => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => undefined);
      } else {
        try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
      }
    };
    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      killTree(false);
      forceTimer = setTimeout(() => killTree(true), 1000);
    };
    const timer = node.timeoutMs ? setTimeout(() => { timedOut = true; stop(); }, node.timeoutMs) : undefined;
    signal?.addEventListener('abort', stop, { once: true });
    let pendingLine = '';
    const collect = (chunk: Buffer): void => {
      const text = chunk.toString();
      output = (output + text).slice(-200_000);
      if (!onLine) return;
      pendingLine += text;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? '';
      for (const line of lines) onLine(line);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const cleanup = (): void => {
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', stop);
      // Descendants can close their inherited pipes and outlive the leader.
      if (stopping) killTree(true);
    };
    child.on('error', error => {
      if (onLine && pendingLine) onLine(pendingLine);
      cleanup();
      resolve({ code: null, output, timedOut, error: `Could not run ${node.command}: ${error.message}` });
    });
    child.on('close', code => {
      if (onLine && pendingLine) onLine(pendingLine);
      cleanup();
      resolve({ code, output, timedOut, ...(signal?.aborted ? { error: 'Check cancelled.' } : {}) });
    });
  });
}
