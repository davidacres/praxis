import type {MobileHostHint} from './mobileHostDiscovery';
export const MOCK_MOBILE_HOST:MobileHostHint={hostId:'mock-host',hostName:'Mock Praxis Host',address:'127.0.0.1',port:43100,hostKeyFingerprint:'mock-key',source:'manual'};
export function createMockHostSnapshot(){return {host:MOCK_MOBILE_HOST,projects:[{projectId:'mock-project',name:'Fixture'}],online:true};}
