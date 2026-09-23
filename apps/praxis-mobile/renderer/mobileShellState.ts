import type {MobileNavigationState} from './mobileNavigation';
/**
 * `pairing`: connected but waiting for the desktop to confirm this phone.
 * `reconnecting`: was ready, lost the connection, and is retrying — the
 * session UI stays up (read-only) instead of dropping back to Connect.
 */
export type MobileShellConnection='offline'|'connecting'|'pairing'|'ready'|'reconnecting';
export interface MobileShellState{navigation:MobileNavigationState;connection:MobileShellConnection;loading:boolean;error?:string;}
export function createMobileShellState():MobileShellState{return {navigation:{primary:'work',detail:'chat'},connection:'offline',loading:false};}
export function setMobileShellConnection(state:MobileShellState,connection:MobileShellConnection):MobileShellState{return {...state,connection,loading:connection==='connecting'||connection==='pairing',error:undefined};}
export function setMobileShellError(state:MobileShellState,error:string):MobileShellState{return {...state,connection:'offline',loading:false,error};}
/** The session UI (not the Connect screen) is shown while ready or briefly reconnecting. */
export function mobileShellShowsWork(state:MobileShellState):boolean{return state.connection==='ready'||state.connection==='reconnecting';}
