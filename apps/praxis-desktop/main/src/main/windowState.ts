import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, type BrowserWindow, screen } from 'electron';

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  isMaximized?: boolean;
}

export const DEFAULT_WINDOW_WIDTH = 1664;
export const DEFAULT_WINDOW_HEIGHT = 936;
export const MIN_WINDOW_WIDTH = 720;
export const MIN_WINDOW_HEIGHT = 480;

export function getWindowStateFilePath(userDataDir?: string): string {
  const base = userDataDir ?? (app ? app.getPath('userData') : process.cwd());
  return path.join(base, 'window-state.json');
}

/**
 * Checks if the given window bounds overlap adequately with any active display's work area.
 * Requires at least 100x100px visible on an active monitor.
 */
export function isBoundsVisibleOnAnyDisplay(
  bounds: { x: number; y: number; width: number; height: number },
  displays: Array<{ workArea: { x: number; y: number; width: number; height: number } }>
): boolean {
  if (
    typeof bounds.x !== 'number' ||
    typeof bounds.y !== 'number' ||
    typeof bounds.width !== 'number' ||
    typeof bounds.height !== 'number' ||
    bounds.width < MIN_WINDOW_WIDTH ||
    bounds.height < MIN_WINDOW_HEIGHT
  ) {
    return false;
  }

  return displays.some(display => {
    const area = display.workArea;
    const overlapX = Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x));
    const overlapY = Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
    return overlapX >= 100 && overlapY >= 100;
  });
}

/**
 * Reads the persisted window bounds from disk and validates that they are visible.
 * If file is missing, corrupted, or off-screen, returns standard default bounds.
 */
export function loadWindowState(
  filePath: string = getWindowStateFilePath(),
  getDisplays: () => Array<{ workArea: { x: number; y: number; width: number; height: number } }> = () =>
    screen ? screen.getAllDisplays() : []
): WindowState {
  const fallback: WindowState = {
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    isMaximized: false
  };

  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WindowState>;

    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') {
      return fallback;
    }

    const width = Math.max(MIN_WINDOW_WIDTH, parsed.width);
    const height = Math.max(MIN_WINDOW_HEIGHT, parsed.height);
    const isMaximized = parsed.isMaximized === true;

    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
      const candidate = { x: parsed.x, y: parsed.y, width, height };
      const displays = getDisplays();
      if (displays.length === 0 || isBoundsVisibleOnAnyDisplay(candidate, displays)) {
        return {
          x: candidate.x,
          y: candidate.y,
          width,
          height,
          isMaximized
        };
      }
    }

    return {
      width,
      height,
      isMaximized
    };
  } catch {
    return fallback;
  }
}

/**
 * Saves window state to disk atomically.
 */
export function saveWindowStateSync(
  win: BrowserWindow,
  filePath: string = getWindowStateFilePath()
): void {
  try {
    if (win.isDestroyed()) {
      return;
    }

    const isMaximized = win.isMaximized();
    // Use getNormalBounds if maximized so unmaximizing later restores the real size.
    const bounds = isMaximized ? win.getNormalBounds() : win.getBounds();

    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(MIN_WINDOW_WIDTH, bounds.width),
      height: Math.max(MIN_WINDOW_HEIGHT, bounds.height),
      isMaximized
    };

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch {
    // Ignore errors saving window state (e.g. during app shutdown or disk full)
  }
}

/**
 * Attaches event listeners to the window to automatically save its position, size,
 * and maximized state when moved, resized, maximized, unmaximized, or closed.
 */
export function attachWindowStatePersistence(
  win: BrowserWindow,
  filePath: string = getWindowStateFilePath()
): () => void {
  let timer: NodeJS.Timeout | undefined;

  const debouncedSave = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      saveWindowStateSync(win, filePath);
    }, 400);
  };

  const handleResize = () => debouncedSave();
  const handleMove = () => debouncedSave();
  const handleMaximize = () => debouncedSave();
  const handleUnmaximize = () => debouncedSave();
  const handleClose = () => {
    if (timer) clearTimeout(timer);
    saveWindowStateSync(win, filePath);
  };

  win.on('resize', handleResize);
  win.on('move', handleMove);
  win.on('maximize', handleMaximize);
  win.on('unmaximize', handleUnmaximize);
  win.on('close', handleClose);

  return () => {
    if (timer) clearTimeout(timer);
    win.removeListener('resize', handleResize);
    win.removeListener('move', handleMove);
    win.removeListener('maximize', handleMaximize);
    win.removeListener('unmaximize', handleUnmaximize);
    win.removeListener('close', handleClose);
  };
}
