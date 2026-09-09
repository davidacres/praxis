import {handleMobileCommand, handleMobileRead, type MobileHostApplication} from '@praxis/core';
export function registerMobileIpc(endpoint:MobileIpcEndpoint,app:MobileHostApplication):void{ registerMobileIpcBridge(endpoint,app); }

export interface MobileIpcEndpoint{handle(channel:string,handler:(event:unknown,payload:any)=>Promise<unknown>):void;}
export function registerMobileIpcBridge(endpoint:MobileIpcEndpoint,app:MobileHostApplication):void{
 endpoint.handle('mobile.read',async(_e,p)=>{return handleMobileRead(app,p);});
 endpoint.handle('mobile.command',async(_e,p)=>{return handleMobileCommand(app,p);});
}
