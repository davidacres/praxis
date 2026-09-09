export interface MobileDecision{requestId:string;hostId:string;projectId:string;runId?:string;version:number;decision:'allow'|'deny';}
export function isCurrentDecision(d:MobileDecision,current:{requestId:string;version:number}):boolean{return d.requestId===current.requestId&&d.version===current.version;}
