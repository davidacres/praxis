export type MobilePrimaryRoute='work'|'attention'|'activity';
export type MobileDetailTab='chat'|'progress'|'changes';
export interface MobileNavigationState{primary:MobilePrimaryRoute;detail:MobileDetailTab;hostId?:string;projectId?:string;}
export const MOBILE_PRIMARY_ROUTES:readonly MobilePrimaryRoute[]=['work','attention','activity'];
export function selectMobileRoute(state:MobileNavigationState,primary:MobilePrimaryRoute):MobileNavigationState{return {...state,primary,detail:primary==='work'?state.detail:'chat'};}
export function selectMobileDetail(state:MobileNavigationState,detail:MobileDetailTab):MobileNavigationState{return {...state,detail};}
