import { app } from 'electron';
import {
  RustHostBridge,
  StdioRustHostTransport,
  hasRustHostBinary
} from './rustHostBridge';
import { getSharedSettingsFilePath } from './settingsBackendInstance';

let bridgeInstance: RustHostBridge | undefined;

/**
 * The default set of tested channels migrated to `crates/praxis-host`.
 */
export const DEFAULT_MIGRATED_CHANNELS: readonly string[] = [
  'host:status',
  'host:getConfig',
  'host:ping',
  'host:emitEvent',
  'host:secrets:get',
  'host:secrets:has',
  'host:secrets:set',
  'host:secrets:delete',
  'host:secrets:listKeys',
  'host:secrets:seed',
  'git:preflight',
  'git:initialize',
  'git:clone',
  'git:open',
  'git:refresh',
  'git:status',
  'git:getCommit',
  'git:getDiff',
  'git:getComparison',
  'git:applyHunk',
  'git:stage',
  'git:unstage',
  'git:discard',
  'git:commit',
  'git:createBranch',
  'git:checkout',
  'git:deleteBranch',
  'git:renameBranch',
  'git:merge',
  'git:rebase',
  'git:getConflict',
  'git:resolveConflict',
  'git:abortConflict',
  'git:getFileContent',
  'git:getFileHistory',
  'git:getBlame',
  'git:cherryPick',
  'git:revert',
  'git:stash',
  'git:popStash',
  'git:pull',
  'git:fetch',
  'git:push'
];

/**
 * Resolves the initial set of migrated channels based on environment settings and binary presence.
 * Set `PRAXIS_RUST_CHANNELS=none` (or `false`, `0`, `off`) to disable delegation.
 * Set `PRAXIS_RUST_CHANNELS=git:*` or a comma-separated list of channel names/prefixes to customize.
 */
export function resolveInitialMigratedChannels(): string[] {
  const envVal = process.env.PRAXIS_RUST_CHANNELS?.trim().toLowerCase();
  if (envVal === 'false' || envVal === '0' || envVal === 'none' || envVal === 'off') {
    return [];
  }
  if (!hasRustHostBinary()) {
    return [];
  }
  if (envVal && envVal !== 'default' && envVal !== 'all' && envVal !== 'true' && envVal !== '1') {
    const requested = envVal.split(',').map(s => s.trim()).filter(Boolean);
    const channels: string[] = [];
    for (const req of requested) {
      if (req.endsWith('*')) {
        const prefix = req.slice(0, -1);
        channels.push(...DEFAULT_MIGRATED_CHANNELS.filter(c => c.startsWith(prefix)));
      } else {
        channels.push(req);
      }
    }
    return channels;
  }
  return [...DEFAULT_MIGRATED_CHANNELS];
}

/**
 * Returns the process-wide [`RustHostBridge`] singleton configured with the current
 * Electron `userData` directory, shared/isolated settings path, `--demo` flag, and `PRAXIS_E2E`.
 *
 * The underlying `praxis-host` process is spawned lazily on the first migrated RPC call
 * or explicit `.start()`.
 */
export function getRustHostBridge(): RustHostBridge {
  if (!bridgeInstance) {
    const transport = new StdioRustHostTransport({
      userDataDir: app.getPath('userData'),
      settingsPath: getSharedSettingsFilePath(),
      demoMode: process.argv.includes('--demo'),
      e2eMode: process.env.PRAXIS_E2E === '1'
    });
    bridgeInstance = new RustHostBridge({
      transport,
      migratedChannels: resolveInitialMigratedChannels()
    });
  }
  return bridgeInstance;
}

/** Disposes the active [`RustHostBridge`] child process on application shutdown. */
export async function disposeRustHost(): Promise<void> {
  const current = bridgeInstance;
  bridgeInstance = undefined;
  if (current) {
    await current.dispose();
  }
}
