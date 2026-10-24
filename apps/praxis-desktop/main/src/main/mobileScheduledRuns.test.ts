import assert from 'node:assert/strict';
import test from 'node:test';
import { ScheduledRunStore, createScheduledRun, InMemoryMobileCommandLedger, handleMobileCommand, type MobileCommand, type MobileHostApplication } from '@praxis/core';
import { createMobileSchedules } from './mobileScheduledRuns';
import { createMobileHostExecutionHandlers, createMobileHostReads, type MobileHostServiceDeps } from './mobileHostServices';

const form = { name: 'Tonight', date: '2026-10-25', time: '20:30', timezone: 'Europe/London', issueKeys: ['A-2', 'A-1'] };
function fixture() {
  const data = new Map<string, unknown>();
  const store = new ScheduledRunStore({ get: <T>(key: string) => data.get(key) as T | undefined, update: async (key, value) => { data.set(key, value); } });
  const changed: string[] = [];
  const schedules = createMobileSchedules({ store: () => store, tickets: async () => ['A-1', 'A-2'].map(issueKey => ({ connectionId: 'project:A', issueKey, title: issueKey })), changed: id => changed.push(id), now: () => '2026-10-24T00:00:00.000Z' });
  const deps = { schedules } as MobileHostServiceDeps;
  const app: MobileHostApplication = { reads: createMobileHostReads(deps), commands: createMobileHostExecutionHandlers(deps), ledger: new InMemoryMobileCommandLedger(), payloadDigest: command => JSON.stringify(command.payload) };
  const command = (operation: MobileCommand['operation'], payload: unknown, id = 'schedule-command-01'): MobileCommand => ({ protocolVersion: 1, commandId: id, issuedAt: '2026-10-24T00:00:00.000Z', caller: { deviceId: 'phone-123456', capabilities: ['view', 'execute'] }, target: { hostId: 'host', projectId: 'A' }, operation, payload });
  return { store, schedules, app, command, changed };
}

test('phone creates ordered drafts, replays commands once and arms/holds using desktop rules', async () => {
  const { app, command, store, changed } = fixture();
  const request = command('scheduledRuns.save', form);
  const first = await handleMobileCommand(app, request) as { id: string; entries: Array<{ issueKey: string }> };
  assert.deepEqual(first.entries.map(e => e.issueKey), ['A-2', 'A-1']);
  assert.deepEqual(await handleMobileCommand(app, request), first);
  assert.equal(store.list().length, 1);
  assert.equal(changed.length, 1);
  await handleMobileCommand(app, command('scheduledRuns.setArmed', { id: first.id, armed: true }, 'schedule-command-02'));
  assert.equal(store.get(first.id)?.status, 'scheduled');
  await handleMobileCommand(app, command('scheduledRuns.setArmed', { id: first.id, armed: false }, 'schedule-command-03'));
  assert.equal(store.get(first.id)?.status, 'draft');
  assert.deepEqual(changed, ['A', 'A', 'A']);
  assert.equal(JSON.stringify(first).includes('connectionId'), false);
});

test('API rejects other projects, unknown tickets, malformed values and view-only mutations', async () => {
  const { app, command, schedules } = fixture();
  const saved = await schedules.save('A', form);
  const crossProject = command('scheduledRuns.setArmed', { id: saved.id, armed: true });
  crossProject.target.projectId = 'B';
  await assert.rejects(handleMobileCommand(app, crossProject), /not found in this project/);
  assert.deepEqual(await schedules.list('B'), []);
  const missingProject = command('scheduledRuns.save', form, 'schedule-command-02');
  delete missingProject.target.projectId;
  await assert.rejects(handleMobileCommand(app, missingProject), /identify a project/);
  const forbidden = command('scheduledRuns.save', form, 'schedule-command-03');
  forbidden.caller.capabilities = ['view'];
  await assert.rejects(handleMobileCommand(app, forbidden), /execute capability/);
  await assert.rejects(handleMobileCommand(app, command('scheduledRuns.save', { ...form, issueKeys: ['B-1'] }, 'schedule-command-04')), /unavailable/);
  await assert.rejects(handleMobileCommand(app, command('scheduledRuns.setArmed', { id: saved.id, armed: 'true' }, 'schedule-command-05')), /boolean/);
});

test('missed runs require explicit resolution; empty schedules cannot be armed', async () => {
  const { schedules, store } = fixture();
  const empty = await schedules.save('A', { ...form, issueKeys: [] });
  await assert.rejects(schedules.setArmed('A', empty.id, true), /ticket/);
  const missed = { ...createScheduledRun({ projectId: 'A', name: 'Missed', scheduledStartAt: '2026-10-23T10:00:00.000Z', timezone: 'UTC', at: '2026-10-22T00:00:00.000Z' }), status: 'missed' as const };
  await store.save(missed);
  assert.equal((await schedules.list('A')).find(run => run.id === missed.id)?.status, 'missed');
  assert.equal((await schedules.resolveMissed('A', missed.id, 'skip')).status, 'cancelled');
  await assert.rejects(schedules.resolveMissed('A', missed.id, 'start-now'), /missed/);
});
