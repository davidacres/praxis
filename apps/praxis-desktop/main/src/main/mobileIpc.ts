import {ipcMain} from 'electron';
import {handleMobileCommand, handleMobileRead, type MobileHostApplication} from '@praxis/core';

export const MOBILE_IPC_CHANNELS = { read: 'mobile.read', command: 'mobile.command' } as const;

export interface MobileIpcEndpoint {
  handle(channel:string,handler:(event:unknown,payload:unknown)=>Promise<unknown>):void;
}

export function registerMobileIpcBridge(endpoint:MobileIpcEndpoint,app:MobileHostApplication):void {
  endpoint.handle(MOBILE_IPC_CHANNELS.read,async(_e,p)=>handleMobileRead(app,p as never));
  endpoint.handle(MOBILE_IPC_CHANNELS.command,async(_e,p)=>handleMobileCommand(app,p as never));
}

export function registerMobileElectronIpc(app:MobileHostApplication):void {
  registerMobileIpcBridge(ipcMain,app);
}
