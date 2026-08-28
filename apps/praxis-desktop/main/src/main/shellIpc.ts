import { ipcMain, shell } from 'electron';

/**
 * Outbound links (issue browse URLs, attachment content URLs) always open in
 * the system browser, never in an Electron window. Only http(s) URLs are
 * honoured — a backend handing us `file://` or a custom scheme gets a logged
 * refusal instead of a protocol handler launch.
 */
export function registerShellIpc(): void {
  ipcMain.handle('shell:openExternal', async (_event, url: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
      console.warn(`shellIpc — refusing to open non-http(s) URL: ${String(url)}`);
      return false;
    }
    await shell.openExternal(url);
    return true;
  });
}
