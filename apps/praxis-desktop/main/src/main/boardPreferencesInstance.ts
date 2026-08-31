import * as path from 'node:path';
import { app } from 'electron';
import { BoardColumnStore } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';

let instance: BoardColumnStore | undefined;

/**
 * Singleton per-board preferences store — the same `BoardColumnStore` class the
 * VS Code extension uses, backed here by a small JSON file under `userData`
 * instead of a workspace memento.
 *
 * The file deliberately lives under `userData` rather than next to the shared
 * settings document: board prefs are high-churn UI state (every card reorder
 * writes), and `userData` honours `--user-data-dir`, so the Playwright suite's
 * throwaway profile isolates prefs without a second env override.
 */
export function getBoardPreferencesStore(): BoardColumnStore {
  if (!instance) {
    const keyValue = new JsonKeyValueStore(
      path.join(app.getPath('userData'), 'board-preferences.json')
    );
    // BoardColumnStore only touches `storage.workspace`; both scopes point at
    // the same file so the store has a valid HostStorage either way.
    instance = new BoardColumnStore({ global: keyValue, workspace: keyValue });
  }
  return instance;
}

export function resetBoardPreferencesStore(): void {
  instance = undefined;
}
