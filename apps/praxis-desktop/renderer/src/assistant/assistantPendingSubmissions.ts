import type { SubmitConversationCommand } from '@praxis/core';

/**
 * Submissions that are in flight or awaiting one transport retry, keyed by the conversation they
 * belong to.
 *
 * Two properties matter, both from AC-D:
 *
 * 1. **Navigation cannot redirect a pending reply.** The stored command already carries its own
 *    `conversationId`, its captured page `context` and its staged `attachmentRefs`, so resubmitting
 *    it after the user opened another chat still targets the original conversation. The map is
 *    therefore *not* cleared when the panel loads or creates a different chat — only when its own
 *    conversation is deleted, or when the submission is acknowledged.
 * 2. **Attachments are staged once.** `stageAttachments` writes real bytes into the profile, so a
 *    retry must reuse the refs the first attempt staged rather than stage them again.
 */
type PendingEntry = { command: SubmitConversationCommand; staged: boolean };

export class PendingSubmissions {
  /** conversationId → submitted text → entry. Nested, so dropping a conversation is exact. */
  private readonly byConversation = new Map<string, Map<string, PendingEntry>>();

  private entry(conversationId: string, text: string): PendingEntry | undefined {
    return this.byConversation.get(conversationId)?.get(text);
  }

  /** The command already built for this conversation+text, so a retry reuses its identity. */
  get(conversationId: string, text: string): SubmitConversationCommand | undefined {
    return this.entry(conversationId, text)?.command;
  }

  /** Whether attachments for this command have already been staged; staging must happen once. */
  hasStagedAttachments(conversationId: string, text: string): boolean {
    return this.entry(conversationId, text)?.staged ?? false;
  }

  record(command: SubmitConversationCommand, staged: boolean): void {
    let entries = this.byConversation.get(command.conversationId);
    if (!entries) this.byConversation.set(command.conversationId, entries = new Map());
    entries.set(command.text, { command, staged });
  }

  /** The submission reached main and was accepted (or duplicated by command id). */
  acknowledge(conversationId: string, text: string): void {
    const entries = this.byConversation.get(conversationId);
    if (!entries) return;
    entries.delete(text);
    if (entries.size === 0) this.byConversation.delete(conversationId);
  }

  /** The conversation itself is gone: nothing pending for it can ever be delivered. */
  dropConversation(conversationId: string): void {
    this.byConversation.delete(conversationId);
  }

  /** Everything still pending, for diagnostics and tests. Never used to derive conversation state. */
  list(): SubmitConversationCommand[] {
    return [...this.byConversation.values()].flatMap(entries => [...entries.values()].map(entry => entry.command));
  }

  get size(): number {
    let total = 0;
    for (const entries of this.byConversation.values()) total += entries.size;
    return total;
  }
}
