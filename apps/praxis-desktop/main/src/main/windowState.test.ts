import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  isBoundsVisibleOnAnyDisplay,
  loadWindowState,
  saveWindowStateSync,
  type WindowState
} from './windowState';

test('isBoundsVisibleOnAnyDisplay: validates bounds within display work area', () => {
  const displays = [
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    { workArea: { x: 1920, y: 0, width: 2560, height: 1440 } }
  ];

  // Inside primary display
  assert.equal(
    isBoundsVisibleOnAnyDisplay({ x: 100, y: 100, width: 1200, height: 800 }, displays),
    true
  );

  // Inside secondary display
  assert.equal(
    isBoundsVisibleOnAnyDisplay({ x: 2000, y: 100, width: 1400, height: 900 }, displays),
    true
  );

  // Completely off-screen to the left
  assert.equal(
    isBoundsVisibleOnAnyDisplay({ x: -2000, y: 100, width: 1200, height: 800 }, displays),
    false
  );

  // Barely touches display (<100px overlap)
  assert.equal(
    isBoundsVisibleOnAnyDisplay({ x: -1150, y: 100, width: 1200, height: 800 }, displays),
    false
  );

  // Below minimum size
  assert.equal(
    isBoundsVisibleOnAnyDisplay({ x: 100, y: 100, width: 400, height: 300 }, displays),
    false
  );
});

test('loadWindowState: returns default bounds when file does not exist', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-state-test-'));
  try {
    const file = path.join(tempDir, 'window-state.json');
    const state = loadWindowState(file, () => []);
    assert.equal(state.width, DEFAULT_WINDOW_WIDTH);
    assert.equal(state.height, DEFAULT_WINDOW_HEIGHT);
    assert.equal(state.x, undefined);
    assert.equal(state.y, undefined);
    assert.equal(state.isMaximized, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadWindowState: restores saved bounds when visible on display', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-state-test-'));
  try {
    const file = path.join(tempDir, 'window-state.json');
    const saved: WindowState = {
      x: 250,
      y: 150,
      width: 1400,
      height: 850,
      isMaximized: true
    };
    fs.writeFileSync(file, JSON.stringify(saved), 'utf8');

    const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
    const state = loadWindowState(file, () => displays);
    assert.equal(state.x, 250);
    assert.equal(state.y, 150);
    assert.equal(state.width, 1400);
    assert.equal(state.height, 850);
    assert.equal(state.isMaximized, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadWindowState: drops position if saved coordinates are off-screen', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-state-test-'));
  try {
    const file = path.join(tempDir, 'window-state.json');
    const saved: WindowState = {
      x: 5000,
      y: 5000,
      width: 1400,
      height: 850,
      isMaximized: false
    };
    fs.writeFileSync(file, JSON.stringify(saved), 'utf8');

    const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }];
    const state = loadWindowState(file, () => displays);
    assert.equal(state.x, undefined);
    assert.equal(state.y, undefined);
    assert.equal(state.width, 1400);
    assert.equal(state.height, 850);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('saveWindowStateSync: persists bounds from BrowserWindow mock', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'window-state-test-'));
  try {
    const file = path.join(tempDir, 'sub', 'window-state.json');
    const mockWin: any = {
      isDestroyed: () => false,
      isMaximized: () => false,
      getBounds: () => ({ x: 300, y: 200, width: 1500, height: 900 })
    };

    saveWindowStateSync(mockWin, file);
    assert.equal(fs.existsSync(file), true);

    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as WindowState;
    assert.equal(saved.x, 300);
    assert.equal(saved.y, 200);
    assert.equal(saved.width, 1500);
    assert.equal(saved.height, 900);
    assert.equal(saved.isMaximized, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
