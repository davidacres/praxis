import type {MobileNavigationState} from './mobileNavigation';
export interface MobileShellState{navigation:MobileNavigationState;connection:'offline'|'connecting'|'ready';loading:boolean;error?:string;}
export function createMobileShellState():MobileShellState{return {navigation:{primary:'work',detail:'chat'},connection:'offline',loading:false};}
export function setMobileShellConnection(state:MobileShellState,connection:MobileShellState['connection']):MobileShellState{return {...state,connection,loading:connection==='connecting',error:undefined};}
export function setMobileShellError(state:MobileShellState,error:string):MobileShellState{return {...state,connection:'offline',loading:false,error};}
