import type { MobilePeerContext } from './mobileAccessPolicy';
export function assertLanOnlyExecution(peer:MobilePeerContext):{allowed:true}|{allowed:false;reason:'relay'|'unauthenticated'|'forwarded'} {
 if(peer.relayRoute)return {allowed:false,reason:'relay'};
 if(!peer.authenticated)return {allowed:false,reason:'unauthenticated'};
 if(peer.forwardedFor)return {allowed:false,reason:'forwarded'};
 return {allowed:true};
}
