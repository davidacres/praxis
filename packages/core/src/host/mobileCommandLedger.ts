import type { MobileEventEnvelope, MobileProtocolError } from './mobileProtocol';

export type MobileCommandState = 'accepted' | 'completed' | 'unknown' | 'rejected';

export interface MobileCommandRecord {
  commandId: string;
  payloadDigest: string;
  state: MobileCommandState;
  outcome?: unknown;
  updatedAt: string;
}

export interface MobileCommandLedger {
  get(commandId: string): MobileCommandRecord | undefined;
  put(record: MobileCommandRecord): void;
  appendEvent<TEvent>(event: MobileEventEnvelope<TEvent>): void;
  replay(afterSequence: number, limit?: number): readonly MobileEventEnvelope[];
  /** Highest sequence appended so far (0 when none). */
  latestSequence(): number;
  /** Lowest sequence still retained; a replay starting before `oldest - 1` has lost events. */
  oldestRetainedSequence(): number;
}

/** Streamed sessions append a full snapshot per change, so the event log is bounded. */
export const MOBILE_EVENT_RETENTION = 5000;

export class InMemoryMobileCommandLedger implements MobileCommandLedger {
  private readonly commands = new Map<string, MobileCommandRecord>();
  private readonly events: MobileEventEnvelope[] = [];

  constructor(private readonly retention = MOBILE_EVENT_RETENTION) {}

  get(commandId: string): MobileCommandRecord | undefined {
    return this.commands.get(commandId);
  }

  put(record: MobileCommandRecord): void {
    this.commands.set(record.commandId, record);
  }

  appendEvent<TEvent>(event: MobileEventEnvelope<TEvent>): void {
    this.events.push(event);
    if (this.events.length > this.retention) this.events.splice(0, this.events.length - this.retention);
  }

  latestSequence(): number {
    return this.events.at(-1)?.sequence ?? 0;
  }

  oldestRetainedSequence(): number {
    return this.events[0]?.sequence ?? this.latestSequence() + 1;
  }

  replay(afterSequence: number, limit = 100): readonly MobileEventEnvelope[] {
    return this.events.filter(event => event.sequence > afterSequence).slice(0, limit);
  }
}

export type CommandAdmission =
  | { ok: true; record: MobileCommandRecord; replay: boolean }
  | { ok: false; error: MobileProtocolError };

export function admitMobileCommand(
  ledger: MobileCommandLedger,
  commandId: string,
  payloadDigest: string,
  issuedAt: string,
): CommandAdmission {
  const existing = ledger.get(commandId);
  if (existing && existing.payloadDigest !== payloadDigest) {
    return {
      ok: false,
      error: {
        code: 'duplicate-command',
        message: 'The command ID was already used with a different payload.',
        retryable: false,
        commandId,
      },
    };
  }
  if (existing) return { ok: true, record: existing, replay: true };

  const record: MobileCommandRecord = {
    commandId,
    payloadDigest,
    state: 'accepted',
    updatedAt: issuedAt,
  };
  ledger.put(record);
  return { ok: true, record, replay: false };
}

export function markMobileCommandUnknown(
  ledger: MobileCommandLedger,
  commandId: string,
  updatedAt: string,
): MobileCommandRecord | undefined {
  const current = ledger.get(commandId);
  if (!current) return undefined;
  const updated = { ...current, state: 'unknown' as const, updatedAt };
  ledger.put(updated);
  return updated;
}

export function completeMobileCommand(
  ledger: MobileCommandLedger,
  commandId: string,
  outcome: unknown,
  updatedAt: string,
): MobileCommandRecord | undefined {
  const current = ledger.get(commandId);
  if (!current) return undefined;
  const updated = { ...current, state: 'completed' as const, outcome, updatedAt };
  ledger.put(updated);
  return updated;
}
