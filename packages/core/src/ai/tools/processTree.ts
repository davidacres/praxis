import * as nodeChildProcess from 'node:child_process';

/**
 * Runs a shell command so that what it leaves behind can be seen (FX-BF-048 / TASK-393).
 *
 * On macOS and Linux the command runs as the leader of its own process group. The tool's
 * result is ready when the shell exits — not when every inherited output pipe closes, so a
 * backgrounded dev server no longer holds the tool open until the timeout. Whatever is still
 * in the group then is a *survivor*: a service the command started. A timeout signals the
 * whole group, not only the shell.
 *
 * A process that calls `setsid` leaves the group and is not seen: that limit is stated in
 * the capability matrix rather than papered over. Windows keeps the plain `exec` route.
 */

export interface ShellRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set when the command failed to start, timed out, or exited non-zero. */
  error?: string;
  timedOut: boolean;
  /** The command's process group (its shell's pid); undefined where groups are not used. */
  pgid?: number;
  /** Processes still in the group after the shell exited. */
  survivors: number[];
}

export const PROCESS_GROUPS_SUPPORTED = process.platform !== 'win32';

/** Members of a process group, by pid. Empty when the group is gone or cannot be listed. */
export function processGroupMembers(pgid: number): number[] {
  if (!PROCESS_GROUPS_SUPPORTED) return [];
  try {
    const out = nodeChildProcess.execFileSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      // A zombie has exited; it holds nothing and is not a survivor.
      .filter(([pid, group, stat]) => Number(group) === pgid && pid && !stat?.startsWith('Z'))
      .map(([pid]) => Number(pid));
  } catch {
    return [];
  }
}

/** TCP ports the given processes listen on (best effort, via `lsof`). */
export function listeningPorts(pids: number[]): number[] {
  if (!PROCESS_GROUPS_SUPPORTED || pids.length === 0) return [];
  try {
    const out = nodeChildProcess.execFileSync('lsof', ['-nP', '-a', '-p', pids.join(','), '-iTCP', '-sTCP:LISTEN', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const ports = new Set<number>();
    for (const line of out.split('\n')) {
      const match = /^n.*:(\d+)$/.exec(line.trim());
      if (match) ports.add(Number(match[1]));
    }
    return [...ports].sort((a, b) => a - b);
  } catch {
    // lsof exits 1 when nothing matches.
    return [];
  }
}

/** Signals a whole process group; true when the signal was delivered. */
export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Stops a process group: SIGTERM, then SIGKILL for anything still there after `graceMs`. */
export async function stopProcessGroup(pgid: number, graceMs = 2000): Promise<boolean> {
  signalProcessGroup(pgid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (processGroupMembers(pgid).length === 0) return true;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  signalProcessGroup(pgid, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 100));
  return processGroupMembers(pgid).length === 0;
}

export function runShellCommand(command: string, options: { cwd: string; timeoutMs: number; maxBuffer: number; signal?: AbortSignal }): Promise<ShellRun> {
  if (!PROCESS_GROUPS_SUPPORTED) {
    return new Promise(resolve => {
      nodeChildProcess.exec(command, { cwd: options.cwd, timeout: options.timeoutMs, maxBuffer: options.maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? 1 : 0;
        resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '', exitCode: code, error: error?.message, timedOut: !!error?.killed, survivors: [] });
      });
    });
  }

  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const child = nodeChildProcess.spawn('/bin/sh', ['-c', command], { cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const pgid = child.pid;
    const append = (current: string, chunk: Buffer) => (current.length >= options.maxBuffer ? current : (current + chunk.toString('utf8')).slice(0, options.maxBuffer));
    child.stdout.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
    let ended = 0;
    let onEnded = () => undefined as void;
    let settledOutput = false;
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('end', () => {
        ended += 1;
        onEnded();
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      if (pgid) void stopProcessGroup(pgid);
    }, options.timeoutMs);
    // The turn was cancelled: the command and everything it started stop with it.
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      if (pgid) void stopProcessGroup(pgid);
    };
    if (options.signal?.aborted) cancel();
    else options.signal?.addEventListener('abort', cancel, { once: true });

    const finish = (code: number | null, signal: NodeJS.Signals | null, failure?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Read what was written until both pipes end — or, if a background process inherited
      // them and keeps them open, for a moment more, then stop: it must not hold the tool open.
      const settle = () => {
        if (settledOutput) return;
        settledOutput = true;
        child.stdout.destroy();
        child.stderr.destroy();
        const survivors = pgid ? processGroupMembers(pgid) : [];
        const exitCode = code ?? (signal ? 128 : 1);
        options.signal?.removeEventListener('abort', cancel);
        const error = failure?.message ?? (cancelled ? 'cancelled: the command and the processes it started were stopped' : timedOut ? `timed out after ${Math.round(options.timeoutMs / 1000)} s; the command's processes were stopped` : exitCode !== 0 ? `exited with code ${exitCode}${signal ? ` (${signal})` : ''}` : undefined);
        resolve({ stdout, stderr, exitCode, ...(error ? { error } : {}), timedOut, pgid, survivors });
      };
      if (ended === 2) settle();
      else {
        const grace = setTimeout(() => settle(), 250);
        onEnded = () => {
          if (ended === 2) {
            clearTimeout(grace);
            settle();
          }
        };
      }
    };
    child.on('exit', (code, signal) => finish(code, signal));
    child.on('error', failure => finish(1, null, failure));
  });
}
