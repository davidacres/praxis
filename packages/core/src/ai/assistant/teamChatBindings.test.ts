import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { resolveTeamChatBinding, type TeamChatConfiguration } from './teamChatBindings';
import type { ConversationBinding } from './assistantTypes';
const configuration: TeamChatConfiguration = { conversationId: 'chat', participantId: 'member', providerRuntime: 'acp', accountReference: 'account', endpoint: 'endpoint', model: 'model', reasoning: 'medium', instructionVersion: '1', canonicalFolder: '/project', executionMode: 'chat', toolPolicy: 'read-only', permissionPolicy: 'manual' };
test('every resolved compatibility dimension invalidates reuse and switching back stays fresh', () => {
  for (const key of Object.keys(configuration) as (keyof TeamChatConfiguration)[]) {
    const bindings: ConversationBinding[] = [];
    const first = resolveTeamChatBinding(bindings, configuration, 'first');
    assert.equal(resolveTeamChatBinding(bindings, configuration, 'unused'), first);
    const changed = { ...configuration, [key]: 'changed' };
    const second = resolveTeamChatBinding(bindings, changed, 'second');
    assert.notEqual(second.id, first.id);
    if (key !== 'participantId') assert.equal(first.status, 'invalid');
    if (key !== 'participantId') assert.equal(resolveTeamChatBinding(bindings, configuration, 'third').id, 'third');
  }
});
