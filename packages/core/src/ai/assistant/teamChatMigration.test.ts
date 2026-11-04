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
  const collisionInput = structuredClone(original);
  assert.throws(() => migrateTeamChats(original), /collision/);
  assert.deepEqual(original, collisionInput);
  const duplicate = structuredClone(chat);
  duplicate.messages.push(duplicate.messages[0]);
  const duplicateInput = structuredClone(duplicate);
  assert.throws(() => importLegacyTeamChat(duplicate), /Duplicate/);
  assert.deepEqual(duplicate, duplicateInput);
  const unsupported = { ...source(), schemaVersion: 99 } as unknown as TeamChatSnapshot;
  const unsupportedInput = structuredClone(unsupported);
  assert.throws(() => migrateTeamChats(unsupported), /Unsupported/);
  assert.deepEqual(unsupported, unsupportedInput);
});

test('a title-only match never merges or links', () => {
  // Two legacy chats share a title and an existing durable conversation has it too:
  // each stays its own conversation and none acquires a binding or runtime link.
  const original = source();
  const twin = { ...structuredClone(chat), id: 'legacy-twin' };
  original.teamChats.push(twin);
  original.conversations.push({ ...importLegacyTeamChat({ ...structuredClone(chat), id: 'durable-existing' }), bindings: [] });
  const migrated = migrateTeamChats(original);
  assert.deepEqual(migrated.conversations.map(c => c.id), ['durable-existing', 'legacy', 'legacy-twin']);
  assert.ok(migrated.conversations.every(c => c.title === 'Existing'));
  assert.ok(migrated.conversations.every(c => c.bindings.length === 0 && c.turns.length === 0));
  assert.equal(migrated.conversations[1].messages.length, chat.messages.length);
});

test('a legacy runtime session key is never treated as a provable association', () => {
  // Legacy chats never recorded which runtime session served them; the only trace is a
  // synthetic ASSISTANT-<uuid> key. Migration must not turn that into a binding.
  const original = source();
  original.teamChats[0].messages.push({ id: 'keyed', role: 'dev', text: 'Answered by ASSISTANT-1234-dev-abcdef0123456789', createdAt: 'now' });
  const migrated = migrateTeamChats(original).conversations[0];
  assert.deepEqual(migrated.bindings, []);
  assert.equal(migrated.coordinatorEpoch, 'imported');
  assert.ok(migrated.messages.every(m => !('participantId' in m)));
});

test('ambiguous legacy results remain diagnostics rather than invented successful attempts', () => {
  const original = source();
  original.legacyDiagnostics = [{ id: 'unbound-result', completedAt: 'now', messages: [chat.messages[0]] }];
  const migrated = migrateTeamChats(original);
  assert.deepEqual(migrated.legacyDiagnostics, original.legacyDiagnostics);
  assert.equal(migrated.conversations.length, 1);
  assert.equal(migrated.conversations[0].turns.length, 0);
});
