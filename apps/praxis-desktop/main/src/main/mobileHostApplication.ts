import type {MobileExecutionHandlers,MobileHostApplication,MobileHostReads} from '@praxis/core';
import type {MobileCommandLedger} from '@praxis/core';

export interface DesktopMobileServiceDependencies{reads:MobileHostReads;commands:MobileExecutionHandlers;ledger:MobileCommandLedger;payloadDigest:(command:unknown)=>string;}
export function createDesktopMobileHostApplication(d:DesktopMobileServiceDependencies):MobileHostApplication{return {reads:d.reads,commands:d.commands,ledger:d.ledger,payloadDigest:d.payloadDigest};}
