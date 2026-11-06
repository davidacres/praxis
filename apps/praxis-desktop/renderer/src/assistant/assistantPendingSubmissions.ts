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
export class PendingSubmissions {
  private readonly entries = new Map<string, { command: SubmitConversationCommand; staged: boolean }>();

  private static key(conversationId: string, text: string): string {
    return `${conversationId}:${text}`;
  }

  /** The command already built for this conversation+text, so a retry reuses its identity. */
  get(conversationId: string, text: string): SubmitConversationCommand | undefined {
    return this.entries.get(PendingSubmissions.key(conversationId, text))?.command;
  }

  /** Whether attachments for this command have already been staged; staging must happen once. */
  hasStagedAttachments(conversationId: string, text: string): boolean {
    return this.entries.get(PendingSubmissions.key(conversationId, text))?.staged ?? false;
  }

  record(command: SubmitConversationCommand, staged: boolean): void {
    this.entries.set(PendingSubmissions.key(command.conversationId, command.text), { command, staged });
  }

  /** The submission reached main and was accepted (or duplicated by command id). */
  acknowledge(conversationId: string, text: string): void {
    this.entries.delete(PendingSubmissions.key(conversationId, text));
  }

  /** The conversation itself is gone: nothing pending for it can ever be delivered. */
  dropConversation(conversationId: string): void {
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${conversationId}:`)) this.entries.delete(key);
    }
  }

  /** Everything still pending, for diagnostics and tests. Never used to derive conversation state. */
  list(): SubmitConversationCommand[] {
    return [...this.entries.values()].map(entry => entry.command);
  }

  get size(): number {
    return this.entries.size;
  }
}
