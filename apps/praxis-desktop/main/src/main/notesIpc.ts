import { trustedIpcMain as ipcMain } from './trustedIpcMain';
import { getNotesStore } from './notesStoreInstance';

/**
 * Registers the notes IPC channels. Arguments arrive as `unknown` and are validated in the
 * store; every handler resolves a `NotesResult` rather than rejecting.
 */
export function registerNotesIpc(): void {
  ipcMain.handle('notes:list', (_event, projectId: unknown) => getNotesStore().list(projectId as string));
  ipcMain.handle('notes:createNote', (_event, projectId: unknown, input: unknown) =>
    getNotesStore().createNote(projectId as string, input));
  ipcMain.handle('notes:updateNote', (_event, projectId: unknown, noteId: unknown, input: unknown) =>
    getNotesStore().updateNote(projectId as string, noteId as string, input));
  ipcMain.handle('notes:deleteNote', (_event, projectId: unknown, noteId: unknown) =>
    getNotesStore().deleteNote(projectId as string, noteId as string));
  ipcMain.handle('notes:createGroup', (_event, projectId: unknown, input: unknown) =>
    getNotesStore().createGroup(projectId as string, input));
  ipcMain.handle('notes:updateGroup', (_event, projectId: unknown, groupId: unknown, input: unknown) =>
    getNotesStore().updateGroup(projectId as string, groupId as string, input));
  ipcMain.handle('notes:deleteGroup', (_event, projectId: unknown, groupId: unknown) =>
    getNotesStore().deleteGroup(projectId as string, groupId as string));
  ipcMain.handle('notes:replaceMemberships', (_event, projectId: unknown, groupId: unknown, noteIds: unknown) =>
    getNotesStore().replaceMemberships(projectId as string, groupId as string, noteIds));
  ipcMain.handle('notes:prepareSnapshot', (_event, projectId: unknown, source: unknown) =>
    getNotesStore().prepareSnapshot(projectId as string, source));
}
