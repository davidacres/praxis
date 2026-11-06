import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { classifyLegacyRuntimeSession, importLegacyTeamChat, LEGACY_VIRTUAL_TEAM_DEFINITION_OF_DONE, migrateTeamChats } from './teamChatMigration';
import type { LegacyRuntimeSessionEvidence, TeamChatRecord, TeamChatSnapshot } from './assistantTypes';

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

test('a runtime session key quoted in message text is never treated as a provable association', () => {
  // Proof comes only from runtime session evidence (see the typed-link tests below); a key
  // that merely appears in transcript text is neither a binding nor a link.
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

const DIGEST = '0123456789abcdef';
const evidence = (over: Partial<LegacyRuntimeSessionEvidence> = {}): LegacyRuntimeSessionEvidence => ({
  issueKey: `ASSISTANT-legacy-dev-${DIGEST}`, provider: 'claude-code', state: 'completed',
  definitionOfDone: LEGACY_VIRTUAL_TEAM_DEFINITION_OF_DONE, checkpointMessageIds: ['a'], ...over });

test('a provable legacy runtime session imports one typed link and no binding', () => {
  const original = source();
  const before = structuredClone(original);
  const items = [evidence(), evidence({ issueKey: 'standalone-session' })];
  const migrated = migrateTeamChats(original, items);
  assert.deepEqual(original, before, 'the source is not mutated');
  assert.deepEqual(migrateTeamChats(original, [...items].reverse()), migrated, 'deterministic whatever the evidence order');
  const converted = migrated.conversations[0];
  assert.deepEqual(converted.legacyRuntimeLinks, [{ runtimeSessionKey: `ASSISTANT-legacy-dev-${DIGEST}`, conversationId: 'legacy',
    participantId: 'part-dev', role: 'dev', provider: 'claude-code', legacyConfigurationDigest: DIGEST, checkpointMessageId: 'a', status: 'imported' }]);
  assert.deepEqual(converted.bindings, [], 'a link never becomes a binding');
  assert.deepEqual(converted.turns, []);
  assert.equal(migrated.legacyRuntimeDiagnostics, undefined, 'a non-legacy key is ignored entirely');
});

test('an instruction or title match without a chat-id key is a diagnostic, never a link or merge', () => {
  // An unsaved chat sent `ASSISTANT-<random uuid>`; its goal text may equal a saved chat's title.
  const original = source();
  const stray = evidence({ issueKey: `ASSISTANT-9b7f3c1e-4d2a-4f00-8e11-aa00bb11cc22-dev-${DIGEST}` });
  const migrated = migrateTeamChats(original, [stray]);
  assert.equal(migrated.conversations.length, 1, 'nothing merges');
  assert.equal(migrated.conversations[0].legacyRuntimeLinks, undefined);
  assert.deepEqual(migrated.legacyRuntimeDiagnostics, [{ runtimeSessionKey: stray.issueKey, reason: 'unknown-conversation' }]);
  const other = evidence({ definitionOfDone: 'Review the ticket.' });
  assert.deepEqual(classifyLegacyRuntimeSession(other, new Map([['legacy', chat]])), { kind: 'diagnostic', reason: 'not-virtual-team' });
});

test('a checkpoint that names another chat\'s message, a wrong-role message, or none, is not proof', () => {
  const chats = new Map([['legacy', chat], ['other', { ...structuredClone(chat), id: 'other', messages: [{ id: 'foreign', role: 'dev' as const, text: 'x', createdAt: 'now' }] }]]);
  for (const checkpointMessageIds of [['foreign'], ['u'], ['orphan'], []]) {
    assert.deepEqual(classifyLegacyRuntimeSession(evidence({ checkpointMessageIds }), chats), { kind: 'diagnostic', reason: 'no-checkpoint' }, String(checkpointMessageIds));
  }
  // `orphan` is a qa message but an error: a failed reply proves nothing either.
  assert.deepEqual(classifyLegacyRuntimeSession(evidence({ issueKey: `ASSISTANT-legacy-qa-${DIGEST}`, checkpointMessageIds: ['orphan'] }), chats),
    { kind: 'diagnostic', reason: 'no-checkpoint' });
  const migrated = migrateTeamChats(source(), [evidence({ checkpointMessageIds: ['u'] })]);
  assert.equal(migrated.conversations[0].legacyRuntimeLinks, undefined);
  assert.equal(migrated.legacyRuntimeDiagnostics?.[0].reason, 'no-checkpoint');
});

test('evidence never changes an already-activated snapshot', () => {
  const activated = migrateTeamChats(source());
  assert.deepEqual(migrateTeamChats(activated, [evidence()]), activated);
  // A durable (non-legacy) conversation with a matching id is not relinked either.
  const mixed = source();
  mixed.teamChats = [];
  mixed.conversations.push(importLegacyTeamChat(chat));
  const migrated = migrateTeamChats(mixed, [evidence()]);
  assert.equal(migrated.conversations[0].legacyRuntimeLinks, undefined);
  assert.equal(migrated.legacyRuntimeDiagnostics, undefined);
});
