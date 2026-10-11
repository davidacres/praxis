import { ipcMain, type IpcMain } from 'electron';
import { isOwnRendererSender } from './rendererNavigationGuard';

// Outside Electron (unit tests under plain Node), require('electron') resolves
// to the binary path string; pass it through untouched so importing modules
// that register IPC still loads. The guard only matters inside the real app.
const guardedIpcMain: IpcMain =
  ipcMain && typeof ipcMain === 'object'
    ? new Proxy(ipcMain, {
        get(target, property) {
          if (property === 'handle' || property === 'handleOnce') {
            return (channel: string, listener: (...args: any[]) => any) => target[property](channel, (event, ...args) => {
              if (!isOwnRendererSender(event, process.env.PRAXIS_DEV_SERVER_URL)) throw new Error('IPC sender is not a trusted application renderer.');
              return listener(event, ...args);
            });
          }
          if (property === 'on' || property === 'once' || property === 'addListener') {
            return (channel: string, listener: (...args: any[]) => void) => target[property](channel, (event, ...args) => {
              // Untrusted one-way messages have no response channel; drop them without crashing main.
              if (!isOwnRendererSender(event, process.env.PRAXIS_DEV_SERVER_URL)) return;
              listener(event, ...args);
            });
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      })
    : (ipcMain as unknown as IpcMain);

/** Every privileged channel is registered through this sender guard. */
export const trustedIpcMain: IpcMain = guardedIpcMain;
