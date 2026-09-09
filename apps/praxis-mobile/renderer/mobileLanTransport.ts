export interface MobileSocket{send(data:string):void;close():void;onmessage?:((event:{data:string})=>void);onclose?:()=>void;}
export interface MobileSocketFactory{connect(address:string,port:number):Promise<MobileSocket>;}
export class MobileLanTransport{
 private socket?:MobileSocket;
 constructor(private readonly factory:MobileSocketFactory,private readonly address:string,private readonly port:number){}
 async connect():Promise<void>{this.socket=await this.factory.connect(this.address,this.port);}
 request<T>(payload:unknown):Promise<T>{if(!this.socket)throw new Error('LAN transport is not connected.');return new Promise((resolve,reject)=>{this.socket!.onmessage=e=>{try{resolve(JSON.parse(e.data) as T);}catch(error){reject(error);}};this.socket!.send(JSON.stringify(payload));});}
 close():void{this.socket?.close();this.socket=undefined;}
}
