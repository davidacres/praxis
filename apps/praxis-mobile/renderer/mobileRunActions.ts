export type MobileRunAction='start'|'retry-stage'|'cancel';
export interface MobileRunActionRequest{action:MobileRunAction;runId:string;projectId:string;expectedVersion:number;}
export function isValidMobileRunAction(r:MobileRunActionRequest):boolean{return !!r.runId&&!!r.projectId&&Number.isInteger(r.expectedVersion)&&r.expectedVersion>=0;}
