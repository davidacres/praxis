export interface MobileReconnectState { attempt:number; nextAttemptAt:string; cursor:number; }
export function nextMobileReconnect(state:MobileReconnectState,now:string,baseDelayMs=250,maxDelayMs=30000):MobileReconnectState {
 const delay=Math.min(maxDelayMs,baseDelayMs*Math.pow(2,state.attempt));
 return {attempt:state.attempt+1,nextAttemptAt:new Date(new Date(now).getTime()+delay).toISOString(),cursor:state.cursor};
}
export function resetMobileReconnect(cursor:number,now:string):MobileReconnectState { return {attempt:0,nextAttemptAt:now,cursor}; }
