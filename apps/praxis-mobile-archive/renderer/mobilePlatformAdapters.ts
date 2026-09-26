export interface MobileSecureStore{get(key:string):Promise<string|undefined>;set(key:string,value:string):Promise<void>;remove(key:string):Promise<void>;}
export interface MobileQrScanner{scan():Promise<string>;}
export interface MobileDiscovery{discover():Promise<readonly {hostId:string;address:string;port:number;hostKeyFingerprint:string}[]>;}
export interface MobileEncryptedSocket{connect(address:string,port:number):Promise<void>;send(payload:string):Promise<string>;close():Promise<void>;}
export interface MobileBrowserSignIn{signIn():Promise<{subject:string;token:string}>;}
export interface MobilePlatformAdapters{secureStore:MobileSecureStore;qrScanner:MobileQrScanner;discovery:MobileDiscovery;socket:MobileEncryptedSocket;browserSignIn?:MobileBrowserSignIn;}
export function createMobilePlatformAdapters(adapters:MobilePlatformAdapters):MobilePlatformAdapters{return adapters;}
