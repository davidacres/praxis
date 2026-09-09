import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileAuditRecord, isMobileDeviceTrusted, revokeMobileDevice } from './mobileAccessAdministration';

const devices=[{deviceId:'phone-1',label:'Dave phone',pairedAt:'2026-09-09T10:00:00.000Z'},{deviceId:'tablet-1',label:'Tablet',pairedAt:'2026-09-09T10:00:00.000Z',revokedAt:'2026-09-09T11:00:00.000Z'}] as const;

test('revokes an active device without changing other devices',()=>{const updated=revokeMobileDevice(devices,'phone-1','2026-09-09T12:00:00.000Z');assert.equal(updated[0].revokedAt,'2026-09-09T12:00:00.000Z');assert.equal(updated[1].revokedAt,'2026-09-09T11:00:00.000Z');});
test('trusted status excludes revoked and future devices',()=>{assert.equal(isMobileDeviceTrusted(devices[0]),true);assert.equal(isMobileDeviceTrusted(devices[1]),false);assert.equal(isMobileDeviceTrusted({...devices[0],pairedAt:'2026-09-10T00:00:00.000Z'}),false);});
test('audit records redact secret-like fields',()=>{const record=createMobileAuditRecord({occurredAt:'2026-09-09T12:00:00.000Z',actorDeviceId:'phone-1',hostId:'host-mac',action:'workflow.start',outcome:'allowed',details:{projectId:'praxis',token:'redact-me',transcriptBody:'omit'}});assert.deepEqual(record.details,{projectId:'praxis'});});
