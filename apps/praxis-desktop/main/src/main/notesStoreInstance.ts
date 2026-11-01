import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { NotesStore } from './notesStore';
import { getProjectStore } from './projectStoreInstance';
import { broadcastToAllWindows } from './windowBroadcast';

let instance: NotesStore | undefined;

/**
 * Singleton notes store. The file lives under `userData` (not a workspace scope): notes are
 * app-owned, never part of a repository or a workspace export, and `--user-data-dir` isolates
 * the e2e profile.
 *
 * Known boundary: removing a project does not purge its notes. They stay in the file but are
 * unreachable (`validateNotesProject` rejects the unknown ID). Purging is a deliberate
 * follow-up, not a silent deletion of user data inside this task.
 */
export function getNotesStore(): NotesStore {
  instance ??= new NotesStore({
    filePath: path.join(app.getPath('userData'), 'notes.json'),
    knownProjectIds: () => getProjectStore().list().map(project => project.id),
    now: () => new Date().toISOString(),
    newId: randomUUID,
    onChanged: projectId => broadcastToAllWindows('notes:changed', projectId)
  });
  return instance;
}

export function resetNotesStore(): void {
  instance = undefined;
}
