import {evaluateMobileAccess,type MobileAccessPolicy,type MobilePeerContext} from './mobileAccessPolicy';
export interface MobileListener {bound:boolean;mode:MobileAccessPolicy['mode'];port?:number;}
export function createMobileListener(policy:MobileAccessPolicy,port=43100):MobileListener{return {bound:policy.mode!=='off',mode:policy.mode,port:policy.mode==='off'?undefined:port};}
export function canAcceptMobilePeer(listener:MobileListener,policy:MobileAccessPolicy,peer:MobilePeerContext):boolean{return listener.bound&&evaluateMobileAccess(policy,peer).allowed;}
export function applyMobileAccessPolicy(listener:MobileListener,policy:MobileAccessPolicy,port=43100):MobileListener{return createMobileListener(policy,port);}
