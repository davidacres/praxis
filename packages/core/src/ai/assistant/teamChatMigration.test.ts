import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { importLegacyTeamChat, migrateTeamChats } from './teamChatMigration';
import type { TeamChatRecord, TeamChatSnapshot } from './assistantTypes';

const chat: TeamChatRecord = { id: 'legacy', projectId: 'p', issueKey: 'P-1', title: 'Existing', createdAt: 'then', updatedAt: 'now', messages: [
  { id: 'orphan', role: 'qa', text: 'Unknown origin', createdAt: 'then', error: true },
  { id: 'u', role: 'user', text: 'Question', createdAt: 'then', contextTitle: 'P-1' },
  { id: 'a', role: 'dev', text: 'Answer', createdAt: 'now', choices: [{ label: 'Next', prompt: 'Continue' }], proposedAction: { kind: 'update-ticket', label: 'Apply', summary: 'Change', description: 'Body' } }
] };
const source = (): TeamChatSnapshot => ({ schemaVersion: 2, revision: 0, teamChats: [structuredClone(chat)], conversations: [] });

test('migration is deterministic, lossless, isolated and never schedules imported history', () => {
  const original = source();
  const first = migrateTeamChats(original);
  assert.deepEqual(first, migrateTeamChats(original));
  assert.deepEqual(original, source());
  assert.deepEqual(first.teamChats, []);
  const converted = first.conversations[0];
  assert.equal(converted.issueKey, 'P-1');
  assert.deepEqual(converted.messages.map(({ sequence, turnId, attachments, provenance, ...message }) => message), chat.messages);
  assert.deepEqual(converted.messages.map(m => m.sequence), [1, 2, 3]);
  assert.equal(converted.messages[0].provenance, 'imported-unknown');
  assert.equal(converted.messages[1].turnId, converted.messages[2].turnId);
  assert.deepEqual(converted.turns, []);
  assert.deepEqual(converted.bindings, []);
  assert.deepEqual(migrateTeamChats(first), first);
});
test('identity collisions fail without modifying the source', () => {
  const original = source();
  original.conversations.push(importLegacyTeamChat(chat));
  assert.throws(() => migrateTeamChats(original), /collision/);
  const duplicate = structuredClone(chat);
  duplicate.messages.push(duplicate.messages[0]);
  assert.throws(() => importLegacyTeamChat(duplicate), /Duplicate/);
  assert.throws(() => migrateTeamChats({ ...source(), schemaVersion: 99 } as unknown as TeamChatSnapshot), /Unsupported/);
});

test('ambiguous legacy results remain diagnostics rather than invented successful attempts', () => {
  const original = source();
  original.legacyDiagnostics = [{ id: 'unbound-result', completedAt: 'now', messages: [chat.messages[0]] }];
  const migrated = migrateTeamChats(original);
  assert.deepEqual(migrated.legacyDiagnostics, original.legacyDiagnostics);
  assert.equal(migrated.conversations.length, 1);
  assert.equal(migrated.conversations[0].turns.length, 0);
});
