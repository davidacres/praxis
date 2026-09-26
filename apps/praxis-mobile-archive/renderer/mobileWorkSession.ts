export interface MobileWorkIdentity{hostId:string;projectId:string;sessionId:string;workId:string;}
export interface MobileWorkSnapshot<T=unknown>{identity:MobileWorkIdentity;value:T;}
export function workCacheKey(i:MobileWorkIdentity):string{return [i.hostId,i.projectId,i.sessionId,i.workId].join(':');}
export function restoreMobileWork<T>(snapshots:readonly MobileWorkSnapshot<T>[],identity:MobileWorkIdentity):T|undefined{return snapshots.find(s=>workCacheKey(s.identity)===workCacheKey(identity))?.value;}
