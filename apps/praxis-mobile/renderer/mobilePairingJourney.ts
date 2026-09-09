export interface LocalPairingJourney{tokenCreated:boolean;tokenConsumed:boolean;deviceConfirmed:boolean;scopeBound:boolean;reconnectVerified:boolean;revocationVerified:boolean;}
export function isLocalPairingJourneyComplete(j:LocalPairingJourney):boolean{return Object.values(j).every(Boolean);}
