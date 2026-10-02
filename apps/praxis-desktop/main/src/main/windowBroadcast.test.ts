import test from 'node:test';
import * as assert from 'node:assert/strict';
import type { BrowserWindow } from 'electron';
import { safeSend, broadcastToWindows } from './windowBroadcast';

test('safeSend: returns false when window is destroyed', () => {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const mockWin: any = {
    isDestroyed: () => true,
    webContents: {
      isDestroyed: () => false,
      mainFrame: { isDestroyed: () => false },
      send: (channel: string, ...args: unknown[]) => sent.push({ channel, args })
    }
  };

  const result = safeSend(mockWin as BrowserWindow, 'test:channel', 123);
  assert.equal(result, false);
  assert.equal(sent.length, 0);
});

test('safeSend: returns false when webContents is destroyed or crashed', () => {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const destroyedWin: any = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => true,
      mainFrame: { isDestroyed: () => false },
      send: (channel: string, ...args: unknown[]) => sent.push({ channel, args })
    }
  };

  assert.equal(safeSend(destroyedWin as BrowserWindow, 'test:channel', 123), false);
  assert.equal(sent.length, 0);

  const crashedWin: any = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isCrashed: () => true,
      mainFrame: { isDestroyed: () => false },
      send: (channel: string, ...args: unknown[]) => sent.push({ channel, args })
    }
  };

  assert.equal(safeSend(crashedWin as BrowserWindow, 'test:channel', 123), false);
  assert.equal(sent.length, 0);
});

test('safeSend: returns false when mainFrame is destroyed', () => {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const mockWin: any = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame: { isDestroyed: () => true },
      send: (channel: string, ...args: unknown[]) => sent.push({ channel, args })
    }
  };

  const result = safeSend(mockWin as BrowserWindow, 'test:channel', 123);
  assert.equal(result, false);
  assert.equal(sent.length, 0);
});

test('safeSend: returns false when mainFrame getter throws disposed error', () => {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const mockWin: any = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      get mainFrame() {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
      send: (channel: string, ...args: unknown[]) => sent.push({ channel, args })
    }
  };

  const result = safeSend(mockWin as BrowserWindow, 'test:channel', 123);
  assert.equal(result, false);
  assert.equal(sent.length, 0);
});

test('safeSend: returns true and calls send when window and frame are intact', () => {
  const sent: Array<{ channel: string; args: unknown[] }> = [];
  const mockWin: any = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame: { isDestroyed: () => false },
      send: (channel: string, ...args: unknown[]) => sent.push({ channel, args })
    }
  };

  const result = safeSend(mockWin as BrowserWindow, 'log:appended', 'hello world');
  assert.equal(result, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { channel: 'log:appended', args: ['hello world'] });
});

test('broadcastToWindows: dispatches to all live windows and skips disposed ones', () => {
  const liveSent: string[] = [];
  const liveWin: any = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      mainFrame: { isDestroyed: () => false },
      send: (_channel: string, msg: string) => liveSent.push(msg)
    }
  };

  const disposedWin: any = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      get mainFrame() {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
      send: () => {
        throw new Error('Should not be called');
      }
    }
  };

  broadcastToWindows([liveWin as BrowserWindow, disposedWin as BrowserWindow], 'log:appended', 'broadcast test');
  assert.deepEqual(liveSent, ['broadcast test']);
});
