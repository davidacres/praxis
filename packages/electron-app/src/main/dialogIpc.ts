import { BrowserWindow, dialog, ipcMain } from 'electron';

/**
 * Native dialog IPC. Kept to the minimum the renderer needs — each method is a
 * specific user gesture (pick a folder), not a general-purpose dialog bridge.
 */
export function registerDialogIpc(): void {
  ipcMain.handle('dialog:pickFolder', async (event, title?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const options: Electron.OpenDialogOptions = {
      title: title ?? 'Select folder',
      // createDirectory lets the user make a new plans folder from the picker
      // instead of having to pre-create it in Explorer.
      properties: ['openDirectory', 'createDirectory']
    };
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    return result.canceled || result.filePaths.length === 0 ? undefined : result.filePaths[0];
  });
}
