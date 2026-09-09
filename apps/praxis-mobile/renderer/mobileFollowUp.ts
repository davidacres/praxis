export type MobileResultState='pending'|'completed'|'failed';
export interface MobileFollowUp{messageId:string;hostId:string;projectId:string;sessionId:string;workId:string;text:string;state:MobileResultState;createdAt:string;result?:string;}
export function followUpScopeKey(m:Pick<MobileFollowUp,'hostId'|'projectId'|'sessionId'|'workId'>):string{return [m.hostId,m.projectId,m.sessionId,m.workId].join(':');}
export function addFollowUp(list:readonly MobileFollowUp[],followUp:MobileFollowUp):readonly MobileFollowUp[]{return [...list,followUp];}
export function updateFollowUp(list:readonly MobileFollowUp[],messageId:string,state:MobileResultState,result?:string):readonly MobileFollowUp[]{return list.map(m=>m.messageId===messageId?{...m,state,result}:m);}
