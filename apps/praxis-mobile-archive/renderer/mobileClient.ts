// The transport only moves opaque payloads; typing the result is the caller's
// job (MobileClient.read<T>). Keeping `read`/`command` generic on the method
// made every implementation — a real socket or a test fake — have to be
// generic too, which a concrete function cannot satisfy.
export interface MobileTransport{read(request:unknown):Promise<unknown>;command(request:unknown):Promise<unknown>;close():void;}
export interface MobileTransportState{status:'disconnected'|'connecting'|'connected'|'offline';hostId?:string;lastCursor:number;}
export class MobileClient{
 constructor(private readonly transport:MobileTransport,public state:MobileTransportState={status:'disconnected',lastCursor:0}){}
 async connect(hostId:string):Promise<void>{this.state={...this.state,status:'connecting',hostId};this.state={...this.state,status:'connected'};}
 async read<T>(request:unknown):Promise<T>{if(this.state.status!=='connected')throw new Error('Mobile host is offline.');return this.transport.read(request) as Promise<T>;}
 async command<T>(request:unknown):Promise<T>{if(this.state.status!=='connected')throw new Error('Mobile host is offline.');return this.transport.command(request) as Promise<T>;}
 disconnect():void{this.transport.close();this.state={...this.state,status:'disconnected',lastCursor:this.state.lastCursor};}
}
