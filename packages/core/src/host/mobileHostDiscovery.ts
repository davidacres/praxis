export interface MobileHostHint { hostId:string; hostName:string; address:string; port:number; hostKeyFingerprint:string; source:'discovery'|'manual'|'last-known'; }
export interface MobileHostIdentityVerifier { verify(hint:MobileHostHint):boolean; }
export function resolveMobileHost(hints:readonly MobileHostHint[], verifier:MobileHostIdentityVerifier):MobileHostHint|undefined {
 for(const hint of hints) if(verifier.verify(hint)) return hint;
 return undefined;
}
export function rememberMobileHost(hint:MobileHostHint):MobileHostHint { return {...hint,source:'last-known'}; }
