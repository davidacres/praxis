import { app, BrowserWindow } from 'electron';

let idleTimer: NodeJS.Timeout | undefined;
let isConfigured = false;

/**
 * Performs memory compaction across Main and all open Renderer windows.
 */
export function compactMemoryNow(): void {
  try {
    if (typeof global.gc === 'function') {
      global.gc();
    }
  } catch {
    // GC not exposed or failed
  }

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents
        .executeJavaScript('if (typeof window.gc === "function") window.gc();', true)
        .catch(() => {
          // Window may be closing or navigating
        });
    }
  }
}

/**
 * Cancels any pending scheduled idle compaction.
 */
export function cancelIdleMemoryCompaction(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = undefined;
  }
}

/**
 * Schedules an idle memory compaction pass after user leaves the window.
 */
export function scheduleIdleMemoryCompaction(delayMs = 3000): void {
  cancelIdleMemoryCompaction();
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    compactMemoryNow();
  }, delayMs);
}

/**
 * Initializes idle memory management for the desktop app.
 */
export function initMemoryManager(): void {
  if (isConfigured) return;
  isConfigured = true;

  app.on('browser-window-blur', () => {
    const hasFocused = BrowserWindow.getAllWindows().some(w => !w.isDestroyed() && w.isFocused());
    if (!hasFocused) {
      scheduleIdleMemoryCompaction(3000);
    }
  });

  app.on('browser-window-focus', () => {
    cancelIdleMemoryCompaction();
  });
}
