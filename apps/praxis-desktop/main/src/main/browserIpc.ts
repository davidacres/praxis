import { BrowserWindow, ipcMain } from 'electron';
import { getAiBrowser } from './aiBrowser';

/**
 * Renderer control channels for the in-app AI browser. Positioning is driven
 * from React (`browser:setBounds` with the placeholder's client rect); the
 * navigation toolbar uses `browser:navigate` / `browser:back` / … . The AI
 * itself reaches the same `WebContentsView` through the gateway browser tools
 * (`aiBrowser.ts` → `AiBrowserBridge`), not through these channels.
 */
export function registerBrowserIpc(): void {
  const win = (event: Electron.IpcMainInvokeEvent): BrowserWindow => {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (!w) throw new Error('No window for browser IPC.');
    return w;
  };

  ipcMain.handle('browser:attach', event => {
    getAiBrowser().attach(win(event));
  });

  ipcMain.handle('browser:setBounds', (event, bounds: { x: number; y: number; width: number; height: number }) => {
    getAiBrowser().setBounds(win(event), bounds);
  });

  ipcMain.handle('browser:setVisible', (event, visible: boolean) => {
    getAiBrowser().setVisible(win(event), Boolean(visible));
  });

  ipcMain.handle('browser:navigate', async (_event, url: string) => {
    return getAiBrowser().navigate(String(url));
  });

  ipcMain.handle('browser:back', () => getAiBrowser().goBack());
  ipcMain.handle('browser:forward', () => getAiBrowser().goForward());
  ipcMain.handle('browser:reload', () => getAiBrowser().reload());
  ipcMain.handle('browser:getState', () => getAiBrowser().currentState());
}
