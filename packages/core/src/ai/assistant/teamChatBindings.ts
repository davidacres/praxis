import type { ConversationBinding } from './assistantTypes';
import { conversationPayloadDigest } from './teamChatTransitions';

/** Resolved safe references only. Credentials must never be passed to this contract. */
export interface TeamChatConfiguration {
  contextLimit?: number;
  conversationId: string;
  participantId: string;
  providerRuntime: string;
  accountReference: string;
  endpoint: string;
  model: string;
  reasoning: string;
  instructionVersion: string;
  canonicalFolder: string;
  executionMode: string;
  toolPolicy: string;
  permissionPolicy: string;
}
export function resolveTeamChatBinding(bindings: ConversationBinding[], configuration: TeamChatConfiguration, id: string): ConversationBinding {
  const compatibilityDigest = conversationPayloadDigest(configuration);
  const current = bindings.find(b => b.participantId === configuration.participantId && b.status === 'valid');
  if (current?.compatibilityDigest === compatibilityDigest) return current;
  for (const binding of bindings) if (binding.participantId === configuration.participantId) binding.status = 'invalid';
  const binding: ConversationBinding = { id, conversationId: configuration.conversationId, participantId: configuration.participantId,
    providerRuntime: configuration.providerRuntime, compatibilityDigest, deliveredMessageIds: [], nativeOutputMessageIds: [], status: 'valid' };
  bindings.push(binding);
  return binding;
}
