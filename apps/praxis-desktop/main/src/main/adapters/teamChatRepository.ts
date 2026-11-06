import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrateTeamChats, type LegacyRuntimeSessionEvidence, type TeamChatRepository, type TeamChatSnapshot } from '@praxis/core';

type Writer = { queue: Promise<void>; uncertain: boolean };
// All windows route IPC to main. All adapter instances for a profile share this lock.
const writers = new Map<string, Writer>();
export class TeamChatStorageError extends Error {
  public constructor(message: string) { super(message); this.name = 'TeamChatStorageError'; }
}
export class TeamChatCommitUncertainError extends TeamChatStorageError {
  public constructor(message: string) { super(message); this.name = 'TeamChatCommitUncertainError'; }
}

function decode(raw: string): TeamChatSnapshot {
  const value = JSON.parse(raw);
  if (!value || !Array.isArray(value.teamChats)) throw new Error('Missing teamChats array.');
  for (const chat of value.teamChats) {
    if (!chat || typeof chat.id !== 'string' || typeof chat.projectId !== 'string' || typeof chat.title !== 'string' ||
        typeof chat.createdAt !== 'string' || typeof chat.updatedAt !== 'string' || !Array.isArray(chat.messages) ||
        chat.messages.some((message: Record<string, unknown>) => !message || typeof message.id !== 'string' || typeof message.text !== 'string' ||
          typeof message.createdAt !== 'string' || !['user', 'lead', 'dev', 'qa', 'security', 'product'].includes(String(message.role)))) throw new Error('Invalid chat record.');
  }
  // Legacy data stays legacy; migration/activation is a separate story.
  if (value.schemaVersion === undefined && Object.keys(value).every(key => key === 'teamChats')) {
    return { schemaVersion: 2, revision: 0, teamChats: value.teamChats, conversations: [] };
  }
  if (value.schemaVersion !== 2 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.conversations)) throw new Error('Invalid conversation envelope.');
  for (const conversation of value.conversations) {
    if (!conversation || conversation.schemaVersion !== 2 || typeof conversation.id !== 'string' || !Number.isSafeInteger(conversation.revision) ||
        conversation.revision < 0 || typeof conversation.coordinatorEpoch !== 'string' ||
        !['messages', 'participants', 'turns', 'bindings', 'summaries', 'pinnedMessageIds', 'commandReceipts'].every(key => Array.isArray(conversation[key]))) throw new Error('Invalid durable conversation.');
  }
  if (value.activation !== undefined && (value.activation?.version !== 1 || typeof value.activation.acceptedNewTurns !== 'boolean' || value.teamChats.length)) throw new Error('Invalid activation state.');
  if (value.legacyDiagnostics !== undefined && (!Array.isArray(value.legacyDiagnostics) || value.legacyDiagnostics.some((item: Record<string, unknown>) =>
      !item || typeof item.id !== 'string' || typeof item.completedAt !== 'string' || !Array.isArray(item.messages)))) throw new Error('Invalid legacy diagnostic.');
  if (value.legacyRuntimeDiagnostics !== undefined && (!Array.isArray(value.legacyRuntimeDiagnostics) || value.legacyRuntimeDiagnostics.some((item: Record<string, unknown>) =>
      !item || typeof item.runtimeSessionKey !== 'string' || !['unknown-conversation', 'not-virtual-team', 'no-checkpoint'].includes(String(item.reason))))) throw new Error('Invalid legacy runtime diagnostic.');
  const uniqueIds = (items: { id: string }[]) => items.every(item => item && typeof item.id === 'string' && item.id.length > 0) && new Set(items.map(item => item.id)).size === items.length;
  if (!uniqueIds(value.teamChats) || !uniqueIds(value.conversations)) throw new Error('Duplicate conversation identity.');
  for (const conversation of value.conversations) {
    if (typeof conversation.title !== 'string' || typeof conversation.createdAt !== 'string' || typeof conversation.updatedAt !== 'string' ||
        !uniqueIds(conversation.messages) || !uniqueIds(conversation.turns) || !uniqueIds(conversation.participants)) throw new Error('Invalid conversation identity or transcript.');
    let sequence = 0;
    for (const message of conversation.messages) {
      if (!Number.isSafeInteger(message.sequence) || message.sequence <= sequence || typeof message.turnId !== 'string' ||
          typeof message.text !== 'string' || typeof message.createdAt !== 'string' || !Array.isArray(message.attachments) ||
          !['user', 'lead', 'dev', 'qa', 'security', 'product'].includes(message.role)) throw new Error('Invalid conversation message.');
      sequence = message.sequence;
    }
    for (const turn of conversation.turns) {
      if (!['queued', 'running', 'completed', 'awaiting_approval', 'context_required', 'failed', 'interrupted', 'outcome_unknown', 'cancelling', 'cancelled'].includes(turn.state) ||
          typeof turn.commandId !== 'string' || typeof turn.payloadDigest !== 'string' || !turn.plan || !Array.isArray(turn.plan.participants) ||
          !Array.isArray(turn.completedParticipantIds) || !Array.isArray(turn.attempts) || !uniqueIds(turn.attempts)) throw new Error('Invalid conversation turn.');
      for (const attempt of turn.attempts) {
        if (attempt.turnId !== turn.id || typeof attempt.participantId !== 'string' || typeof attempt.coordinatorEpoch !== 'string' ||
            !Number.isSafeInteger(attempt.ordinal) || attempt.ordinal < 1 || !attempt.contextReceipt || typeof attempt.contextReceipt.digest !== 'string' ||
            !Array.isArray(attempt.contextReceipt.messageIds) || !['prepared', 'dispatching', 'running', 'awaiting_approval', 'completed', 'failed', 'interrupted', 'outcome_unknown', 'cancelled'].includes(attempt.state)) throw new Error('Invalid conversation attempt.');
        if (attempt.recoveryEvidence !== undefined && (!Array.isArray(attempt.recoveryEvidence) || attempt.recoveryEvidence.some((evidence: Record<string, unknown>) =>
          !evidence || typeof evidence.id !== 'string' || evidence.conversationId !== conversation.id || evidence.turnId !== turn.id ||
          evidence.participantId !== attempt.participantId || evidence.attemptId !== attempt.id || evidence.coordinatorEpoch !== attempt.coordinatorEpoch ||
          (evidence.observingEpoch !== undefined && (typeof evidence.observingEpoch !== 'string' || !evidence.observingEpoch)) ||
          typeof evidence.observedAt !== 'string' || typeof evidence.provenance !== 'string' ||
          (evidence.result !== undefined && (!evidence.result || typeof evidence.result !== 'object' ||
            typeof (evidence.result as { text?: unknown }).text !== 'string')) ||
          !['partial_output', 'tool_activity', 'final_result', 'runtime_identity', 'reconciliation', 'decision'].includes(String(evidence.kind))))) throw new Error('Invalid recovery evidence.');
      }
    }
    const messageIds = new Set(conversation.messages.map((message: { id: string }) => message.id));
    if (!uniqueIds(conversation.bindings) || !uniqueIds(conversation.summaries) ||
        conversation.pinnedMessageIds.some((id: string) => !messageIds.has(id))) throw new Error('Invalid binding, summary or pinned source.');
    if (conversation.legacyRuntimeLinks !== undefined) {
      const participantIds = new Set(conversation.participants.map((participant: { id: string }) => participant.id));
      if (!Array.isArray(conversation.legacyRuntimeLinks) || conversation.legacyRuntimeLinks.some((link: Record<string, unknown>) =>
        !link || typeof link.runtimeSessionKey !== 'string' || link.conversationId !== conversation.id || !participantIds.has(String(link.participantId)) ||
        !['lead', 'dev', 'qa', 'security', 'product'].includes(String(link.role)) || (link.provider !== undefined && typeof link.provider !== 'string') ||
        typeof link.legacyConfigurationDigest !== 'string' || !messageIds.has(String(link.checkpointMessageId)) || link.status !== 'imported')) throw new Error('Invalid legacy runtime link.');
    }
    const currentParticipants = new Set<string>();
    for (const binding of conversation.bindings) {
      if (binding.conversationId !== conversation.id || typeof binding.participantId !== 'string' ||
          typeof binding.compatibilityDigest !== 'string' || typeof binding.providerRuntime !== 'string' ||
          !['valid', 'invalid'].includes(binding.status) || !Array.isArray(binding.deliveredMessageIds) || !Array.isArray(binding.nativeOutputMessageIds) ||
          [...binding.deliveredMessageIds, ...binding.nativeOutputMessageIds, ...(binding.summarizedMessageIds ?? [])].some(id => !messageIds.has(id))) throw new Error('Invalid provider binding.');
      if (binding.status === 'valid') {
        if (currentParticipants.has(binding.participantId)) throw new Error('Multiple current participant bindings.');
        currentParticipants.add(binding.participantId);
      }
    }
    for (const summary of conversation.summaries) {
      if (!Number.isSafeInteger(summary.version) || summary.version < 1 || typeof summary.text !== 'string' ||
          typeof summary.sourceDigest !== 'string' || typeof summary.attemptId !== 'string' || typeof summary.provider !== 'string' ||
          (summary.sourceMessageIds && (!Array.isArray(summary.sourceMessageIds) || summary.sourceMessageIds.some((id: string) => !messageIds.has(id))))) throw new Error('Invalid summary provenance.');
    }
    if (conversation.summaryAttempts !== undefined && (!Array.isArray(conversation.summaryAttempts) || !uniqueIds(conversation.summaryAttempts) ||
        conversation.summaryAttempts.some((attempt: { provider: unknown; sourceDigest: unknown; state: string }) => typeof attempt.provider !== 'string' || typeof attempt.sourceDigest !== 'string' || !['dispatching', 'completed', 'failed'].includes(attempt.state)))) throw new Error('Invalid summary attempt.');
    if (conversation.decisionCorrections !== undefined && !Array.isArray(conversation.decisionCorrections)) throw new Error('Invalid decision corrections.');
    for (const correction of conversation.decisionCorrections ?? []) {
      if (!messageIds.has(correction.messageId) || !messageIds.has(correction.supersedesMessageId)) throw new Error('Invalid decision correction.');
    }
    if (conversation.controlReceipts !== undefined && (!Array.isArray(conversation.controlReceipts) ||
        new Set(conversation.controlReceipts.map((receipt: { commandId: string }) => receipt.commandId)).size !== conversation.controlReceipts.length ||
        conversation.controlReceipts.some((receipt: { commandId: unknown; payloadDigest: unknown; revision: number }) => !receipt || typeof receipt.commandId !== 'string' ||
          typeof receipt.payloadDigest !== 'string' || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > conversation.revision))) throw new Error('Invalid control receipt.');
    const commandIds = new Set<string>();
    for (const receipt of conversation.commandReceipts) {
      if (!receipt || typeof receipt.commandId !== 'string' || commandIds.has(receipt.commandId) || typeof receipt.payloadDigest !== 'string' ||
          !conversation.turns.some((turn: { id: string }) => turn.id === receipt.turnId) || !Number.isSafeInteger(receipt.revision) ||
          receipt.revision < 1 || receipt.revision > conversation.revision || receipt.outcome !== 'accepted') throw new Error('Invalid command receipt.');
      commandIds.add(receipt.commandId);
    }
  }
  return value as TeamChatSnapshot;
}

export class FileTeamChatRepository implements TeamChatRepository {
  private readonly filePath: string;
  private readonly writer: Writer;
  public constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    let writer = writers.get(this.filePath);
    if (!writer) { writer = { queue: Promise.resolve(), uncertain: false }; writers.set(this.filePath, writer); }
    this.writer = writer;
    this.read(); // Fail visibly before accepting any command against corrupt data.
  }
  public read(): TeamChatSnapshot {
    try { return decode(fs.readFileSync(this.filePath, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 2, revision: 0, teamChats: [], conversations: [] };
      throw new TeamChatStorageError(`Cannot read team chat storage ${this.filePath}: ${String(error)}`);
    }
  }
  public transaction<T>(mutate: (draft: TeamChatSnapshot) => T): Promise<T> {
    const write = this.writer.queue.then(async () => {
      if (this.writer.uncertain) throw new TeamChatCommitUncertainError('Team chat commit is uncertain; reload and reconcile before writing.');
      const current = this.read();
      const draft = structuredClone(current);
      const result = mutate(draft);
      if (result instanceof Promise) throw new Error('Team chat mutations must be synchronous.');
      draft.revision = current.revision + 1;
      const serialized = JSON.stringify(draft, null, 2);
      decode(serialized);
      await this.commit(serialized);
      return structuredClone(result);
    });
    this.writer.queue = write.then(() => undefined, () => undefined);
    return write;
  }
  /** Backup and cutover share the writer lock with every transcript save. */
  public activate(evidence: readonly LegacyRuntimeSessionEvidence[] = []): Promise<void> {
    const activation = this.writer.queue.then(async () => {
      if (this.writer.uncertain) throw new TeamChatCommitUncertainError('Reconcile before activation.');
      const current = this.read();
      if (current.activation?.version === 1) return;
      const candidate = migrateTeamChats(current, evidence);
      candidate.revision++;
      const serialized = JSON.stringify(candidate, null, 2);
      decode(serialized);
      const original = await fs.promises.readFile(this.filePath, 'utf8').catch(error => {
        if (error.code === 'ENOENT') return JSON.stringify({ teamChats: [] });
        throw error;
      });
      const backupPath = `${this.filePath}.v1-backup`;
      const backup = JSON.stringify({ version: 1, original });
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        const file = await fs.promises.open(backupPath, 'wx', 0o600);
        try { await file.writeFile(backup); await file.sync(); } finally { await file.close(); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (await fs.promises.readFile(backupPath, 'utf8') !== backup) throw new Error('Legacy backup does not match source.');
      decode(JSON.parse(backup).original);
      await this.commit(serialized);
    });
    this.writer.queue = activation.then(() => undefined, () => undefined);
    return activation;
  }
  /** Forward repair is mandatory once any durable turn has been accepted. */
  public restoreBeforeAcceptance(): Promise<void> {
    const restore = this.writer.queue.then(async () => {
      if (this.writer.uncertain) throw new TeamChatCommitUncertainError('Reconcile before restoration.');
      const current = this.read();
      if (current.activation?.acceptedNewTurns || current.conversations.some(c => c.turns.length)) throw new Error('Durable turns have been accepted; use forward repair.');
      const backup = JSON.parse(await fs.promises.readFile(`${this.filePath}.v1-backup`, 'utf8'));
      if (backup.version !== 1 || typeof backup.original !== 'string') throw new Error('Invalid backup version.');
      decode(backup.original);
      await this.commit(backup.original);
    });
    this.writer.queue = restore.then(() => undefined, () => undefined);
    return restore;
  }
  /** Reconciliation must inspect the reloaded receipts before acknowledging an uncertain command. */
  public reconcile(inspect: (snapshot: TeamChatSnapshot) => void): Promise<void> {
    const recovery = this.writer.queue.then(() => { inspect(this.read()); this.writer.uncertain = false; });
    this.writer.queue = recovery.then(() => undefined, () => undefined);
    return recovery;
  }
  private async commit(serialized: string): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.promises.mkdir(directory, { recursive: true });
    const temp = `${this.filePath}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      const file = await fs.promises.open(temp, 'wx', 0o600);
      try { await file.writeFile(serialized, 'utf8'); await file.sync(); } finally { await file.close(); }
      await fs.promises.rename(temp, this.filePath);
      renamed = true;
      if (process.platform !== 'win32') {
        const folder = await fs.promises.open(directory, 'r');
        try { await folder.sync(); } finally { await folder.close(); }
      }
    } catch (error) {
      if (renamed) {
        this.writer.uncertain = true;
        throw new TeamChatCommitUncertainError(`Team chat rename succeeded but durability is uncertain: ${String(error)}`);
      }
      throw error;
    } finally { await fs.promises.rm(temp, { force: true }).catch(() => undefined); }
  }
}
