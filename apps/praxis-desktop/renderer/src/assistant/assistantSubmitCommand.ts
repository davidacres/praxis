import type { AssistantRole, PageAssistantContext, SubmitConversationCommand } from '@praxis/core';

/** What `AssistantProvider.send` captured at the moment the user pressed send. */
export interface SubmitCommandInput {
  conversationId: string;
  commandId: string;
  expectedRevision: number;
  /** The trimmed composer text, `@mention`s included verbatim — core routes them. */
  text: string;
  members: readonly AssistantRole[];
  attachmentRefs: SubmitConversationCommand['attachmentRefs'];
  /** The page context as captured at send time; `undefined` when detached or nothing is registered. */
  context: PageAssistantContext | undefined;
  runtimeOptions: Record<string, unknown>;
}

/**
 * Build the one fenced command a send submits.
 *
 * Pure so the send rules can be tested without a DOM:
 * - a detached (or absent) page context leaves out the `context` field entirely, so that one
 *   message goes out with no page, and the detach applies to that message only (`send` then
 *   clears it);
 * - a captured context is cloned, so navigating after a send cannot change what a queued
 *   submission carries;
 * - the text is passed through unchanged, so a mention still reaches its member;
 * - only string runtime options go over the bridge.
 */
export function buildSubmitCommand(input: SubmitCommandInput): SubmitConversationCommand {
  return {
    conversationId: input.conversationId,
    commandId: input.commandId,
    expectedRevision: input.expectedRevision,
    text: input.text,
    selectedParticipantIds: input.members.map(role => `part-${role}`),
    attachmentRefs: [...input.attachmentRefs],
    ...(input.context ? { context: structuredClone(input.context) } : {}),
    runtimeOptions: Object.fromEntries(
      Object.entries(input.runtimeOptions).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    )
  };
}
