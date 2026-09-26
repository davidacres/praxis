export interface LanContinuationEvidence{pairing:boolean;discovery:boolean;continuation:boolean;followUp:boolean;reconnect:boolean;decision:boolean;result:boolean;}
export function isLanContinuationComplete(e:LanContinuationEvidence):boolean{return Object.values(e).every(Boolean);}
