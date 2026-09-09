export interface MobileTransport{read<T>(request:unknown):Promise<T>;command<T>(request:unknown):Promise<T>;close():void;}
export interface MobileTransportState{status:'disconnected'|'connecting'|'connected'|'offline';hostId?:string;lastCursor:number;}
export class MobileClient{
 constructor(private readonly transport:MobileTransport,public state:MobileTransportState={status:'disconnected',lastCursor:0}){}
 async connect(hostId:string):Promise<void>{this.state={...this.state,status:'connecting',hostId};this.state={...this.state,status:'connected'};}
 async read<T>(request:unknown):Promise<T>{if(this.state.status!=='connected')throw new Error('Mobile host is offline.');return this.transport.read<T>(request);}
 async command<T>(request:unknown):Promise<T>{if(this.state.status!=='connected')throw new Error('Mobile host is offline.');return this.transport.command<T>(request);}
 disconnect():void{this.transport.close();this.state={...this.state,status:'disconnected',lastCursor:this.state.lastCursor};}
}
