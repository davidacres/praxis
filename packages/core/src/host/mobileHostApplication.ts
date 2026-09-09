import {dispatchMobileCommand,type MobileExecutionHandlers} from './mobileExecutionBoundary';
import {admitMobileCommand,completeMobileCommand,markMobileCommandUnknown,type MobileCommandLedger} from './mobileCommandLedger';
import {callerHasCapability,type MobileCommand,type MobileReadRequest,validateMobileCommand} from './mobileProtocol';

export interface MobileHostReads { [operation:string]:(request:MobileReadRequest)=>Promise<unknown>; }
export interface MobileHostApplication { reads:MobileHostReads; commands:MobileExecutionHandlers; ledger:MobileCommandLedger; payloadDigest:(command:MobileCommand)=>string; }

export async function handleMobileRead(app:MobileHostApplication,request:MobileReadRequest):Promise<unknown>{
 if(!callerHasCapability(request.caller,request.operation)) throw new Error('The caller is not authorised for this operation.');
 const handler=app.reads[request.operation]; if(!handler) throw new Error('Read operation is not available.');
 return handler(request);
}
export async function handleMobileCommand(app:MobileHostApplication,command:MobileCommand):Promise<unknown>{
 const validation=validateMobileCommand(command); if(!validation.ok) throw new Error(validation.error.message);
 const admission=admitMobileCommand(app.ledger,command.commandId,app.payloadDigest(command),command.issuedAt);
 if(!admission.ok) throw new Error(admission.error.message);
 if(admission.replay) return admission.record.outcome;
 try{const result=await dispatchMobileCommand(command,app.commands);if(!result.ok){markMobileCommandUnknown(app.ledger,command.commandId,new Date().toISOString());throw new Error(result.error.message);}completeMobileCommand(app.ledger,command.commandId,result.value,new Date().toISOString());return result.value;}catch(error){markMobileCommandUnknown(app.ledger,command.commandId,new Date().toISOString());throw error;}
}
