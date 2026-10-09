import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentEventSummary, AgentConversationMessage } from './agentTypes';

/** Full conversation transcript persisted separately from the lightweight session index. */
export interface SessionTranscript {
  events: AgentEventSummary[];
  conversationHistory?: AgentConversationMessage[];
  planText?: string;
  reasoningText?: string;
  responseText?: string;
}

/** Storage contract for reading, writing, and purging per-session transcripts. */
export interface SessionTranscriptStore {
  loadTranscript(sessionId: string): Promise<SessionTranscript | undefined>;
  saveTranscript(sessionId: string, transcript: SessionTranscript): Promise<void>;
  deleteTranscript(sessionId: string): Promise<void>;
}

/**
 * File-backed transcript store writing individual JSON files under a dedicated directory.
 * Writes atomically via temporary files to avoid partial or corrupted transcripts.
 */
export class FileSessionTranscriptStore implements SessionTranscriptStore {
  private readonly dir: string;

  public constructor(dir: string) {
    this.dir = dir;
  }

  private filePath(sessionId: string): string {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.dir, `${safeId}.json`);
  }

  public async loadTranscript(sessionId: string): Promise<SessionTranscript | undefined> {
    const file = this.filePath(sessionId);
    try {
      const data = await fs.promises.readFile(file, 'utf-8');
      const parsed = JSON.parse(data) as Partial<SessionTranscript>;
      return {
        events: Array.isArray(parsed.events) ? parsed.events : [],
        conversationHistory: Array.isArray(parsed.conversationHistory) ? parsed.conversationHistory : undefined,
        planText: typeof parsed.planText === 'string' ? parsed.planText : undefined,
        reasoningText: typeof parsed.reasoningText === 'string' ? parsed.reasoningText : undefined,
        responseText: typeof parsed.responseText === 'string' ? parsed.responseText : undefined
      };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return undefined;
      }
      throw err;
    }
  }

  public async saveTranscript(sessionId: string, transcript: SessionTranscript): Promise<void> {
    await fs.promises.mkdir(this.dir, { recursive: true });
    const file = this.filePath(sessionId);
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    const payload = JSON.stringify(transcript, null, 2);
    await fs.promises.writeFile(tmp, payload, 'utf-8');
    await fs.promises.rename(tmp, file);
  }

  public async deleteTranscript(sessionId: string): Promise<void> {
    const file = this.filePath(sessionId);
    try {
      await fs.promises.unlink(file);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

/** In-memory transcript store for tests and headless environments. */
export class InMemorySessionTranscriptStore implements SessionTranscriptStore {
  private readonly store = new Map<string, SessionTranscript>();

  public async loadTranscript(sessionId: string): Promise<SessionTranscript | undefined> {
    const item = this.store.get(sessionId);
    return item ? JSON.parse(JSON.stringify(item)) as SessionTranscript : undefined;
  }

  public async saveTranscript(sessionId: string, transcript: SessionTranscript): Promise<void> {
    this.store.set(sessionId, JSON.parse(JSON.stringify(transcript)) as SessionTranscript);
  }

  public async deleteTranscript(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }

  public clear(): void {
    this.store.clear();
  }
}
