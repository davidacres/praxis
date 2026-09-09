/**
 * Cross-platform "kill the whole tree, not just the leader" (FX-BE-055 /
 * TASK-144, extracted for reuse in TASK-156).
 *
 * POSIX: `detached: true` at spawn time makes the child its own process
 * group leader, torn down here with a negative-pid signal. Windows has no
 * process groups, so `taskkill /T` walks the tree instead. Only a pid the
 * caller itself obtained from `child_process.spawn` is ever touched — this
 * function has no path that accepts or guesses at a foreign pid.
 *
 * Shared by `projects/runServiceManager.ts` and `deployments/directProcessExecutor.ts`,
 * which previously carried byte-identical private copies of this logic.
 */

import { execFile, type ChildProcess } from 'node:child_process';

export function killProcessTree(child: ChildProcess, force: boolean): Promise<void> {
  return new Promise(resolve => {
    if (!child.pid) {
      resolve();
      return;
    }
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolve());
      return;
    }
    try {
      process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(force ? 'SIGKILL' : 'SIGTERM');
    }
    resolve();
  });
}
