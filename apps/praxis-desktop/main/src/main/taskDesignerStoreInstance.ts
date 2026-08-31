import * as path from 'node:path';
import { app } from 'electron';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';

let instance: JsonKeyValueStore | undefined;

/**
 * Singleton Task Designer canvas store — a small JSON file under `userData`
 * (`task-designer.json`), the desktop counterpart of the extension's
 * workspaceState memento. Like board preferences it deliberately lives under
 * `userData` (high-churn UI state, honours `--user-data-dir` so the Playwright
 * suite's throwaway profiles isolate canvases).
 *
 * Keys are `canvas.<connectionId|'default'>.<boardId>` — each board gets its
 * own canvas, scoped per connection like the extension's state key.
 */
export function getTaskDesignerStore(): JsonKeyValueStore {
  if (!instance) {
    instance = new JsonKeyValueStore(path.join(app.getPath('userData'), 'task-designer.json'));
  }
  return instance;
}

export function taskDesignerCanvasKey(boardId: string, connectionId?: string): string {
  const connectionScope = connectionId?.trim() || 'default';
  return `canvas.${connectionScope}.${boardId}`;
}

export function resetTaskDesignerStore(): void {
  instance = undefined;
}
