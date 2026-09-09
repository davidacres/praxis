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
}

export class InMemoryMobileCommandLedger implements MobileCommandLedger {
  private readonly commands = new Map<string, MobileCommandRecord>();
  private readonly events: MobileEventEnvelope[] = [];

  get(commandId: string): MobileCommandRecord | undefined {
    return this.commands.get(commandId);
  }

  put(record: MobileCommandRecord): void {
    this.commands.set(record.commandId, record);
  }

  appendEvent<TEvent>(event: MobileEventEnvelope<TEvent>): void {
    this.events.push(event);
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
