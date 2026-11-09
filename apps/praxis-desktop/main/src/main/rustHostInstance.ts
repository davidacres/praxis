import * as path from 'node:path';
import { isRustHostBinaryStale } from './rustHostSelection';
import { app } from 'electron';
import {
  RustHostBridge,
  StdioRustHostTransport,
  resolveRustHostBinaryPath,
  hasRustHostBinary
} from './rustHostBridge';
import { getSharedSettingsFilePath } from './settingsBackendInstance';

let bridgeInstance: RustHostBridge | undefined;

/**
 * The default set of tested channels migrated to `crates/praxis-host`.
 */
export const DEFAULT_MIGRATED_CHANNELS: readonly string[] = [
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
  'git:push',
  'settings:get',
  // Keep desktop settings writes on TypeScript: it owns the synchronous cache and
  // change notifications. Rust write cutover requires shared-file coordination (TASK-537).
  'folder:discoverPlans'
];

/**
 * Resolves the initial set of migrated channels based on environment settings and binary presence.
 * Set `PRAXIS_RUST_CHANNELS=none` (or `false`, `0`, `off`) to disable delegation.
 * Set `PRAXIS_RUST_CHANNELS=git:*` or a comma-separated list of channel names/prefixes to customize.
 */
export function resolveInitialMigratedChannels(packaged = app?.isPackaged ?? false): string[] {
  if (packaged) return [];
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
    const migratedChannels = resolveInitialMigratedChannels();
    const rustEnabled = migratedChannels.length > 0;
    const binaryPath = rustEnabled ? resolveRustHostBinaryPath() : undefined;
    const reason = app.isPackaged ? 'Packaged releases stay on TypeScript until TASK-537 parity is proven.'
      : rustEnabled ? 'Local Rust delegation enabled.'
      : hasRustHostBinary() ? 'Delegation disabled by PRAXIS_RUST_CHANNELS.' : 'No usable local Rust host binary.';
    const diagnostics = { mode: rustEnabled ? 'rust' as const : 'typescript' as const,
      reason, binaryPath, delegatedChannelCount: migratedChannels.length };
    console.info('[rustHost] Backend selection:', diagnostics);
    if (binaryPath) {
      try {
        if (isRustHostBinaryStale(binaryPath, path.resolve(__dirname, '../../../../..'))) {
          console.warn('[rustHost] Selected binary is older than Rust sources or manifests; rebuild with npm run build:rust.', binaryPath);
        }
      } catch (error) {
        console.warn('[rustHost] Could not check binary freshness.', error);
      }
    }
    const transport = new StdioRustHostTransport({
      executablePath: binaryPath,
      onReady: status => console.info('[rustHost] Running host:', { binaryPath, ...status }),
      userDataDir: app.getPath('userData'),
      settingsPath: getSharedSettingsFilePath(),
      demoMode: process.argv.includes('--demo'),
      e2eMode: process.env.PRAXIS_E2E === '1'
    });
    bridgeInstance = new RustHostBridge({
      transport,
      migratedChannels,
      diagnostics
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
