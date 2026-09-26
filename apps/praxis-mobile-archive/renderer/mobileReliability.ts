export interface MobileSuspensionState{wasSuspended:boolean;lastCursor:number;pendingCommandIds:readonly string[];}
export function restoreAfterSuspension(s:MobileSuspensionState,cursor:number):MobileSuspensionState{return {...s,wasSuspended:false,lastCursor:Math.max(s.lastCursor,cursor)};}
