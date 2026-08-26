import { spawn } from 'node:child_process';

/**
 * Cross-platform, zero-cost check for whether `command` resolves to a
 * spawnable executable — used to report CLI-hosted AI providers' real
 * install status without any network/LLM call (spawning a real prompt
 * through an ACP agent or the Copilot SDK is a genuine paid completion, not
 * something to run just to populate a settings screen).
 *
 * Leverages Node's own child_process PATH resolution rather than
 * reimplementing it — it already honors Windows PATHEXT, so it finds npm's
 * `.cmd`/`.ps1` global-install shims the same way a user's shell would.
 * Resolves as soon as the OS confirms the process started (`spawn`) or
 * failed to (`error`, e.g. ENOENT) — no arbitrary timeout needed.
 */
export function isExecutableAvailable(command: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const child = spawn(command, [], { stdio: 'ignore' });
    const finish = (available: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (!child.killed) {
        child.kill();
      }
      resolve(available);
    };
    child.once('spawn', () => finish(true));
    child.once('error', () => finish(false));
  });
}
