/**
 * Keeps a phone's copy of desktop sessions consistent across streaming,
 * replay and reconnect. Every snapshot carries the host event sequence it is
 * current as of (a `sessions.get` read carries `host.info.latestSequence`), and
 * each one replaces the whole session — messages included — so applying the
 * higher-sequence snapshot is idempotent: a replayed or re-read snapshot can
 * neither duplicate a message nor roll a streamed reply back.
 *
 * A desktop restart restarts its sequence at zero; the caller detects that
 * with `host.info.hostEpoch` and starts a fresh mirror.
 */
export interface SequencedSnapshot {
  sessionId: string;
  sequence: number;
}

export function mergeSequencedSnapshot<T extends SequencedSnapshot>(
  current: Readonly<Record<string, T>>,
  incoming: T,
): Readonly<Record<string, T>> {
  const existing = current[incoming.sessionId];
  if (existing && existing.sequence > incoming.sequence) return current;
  return { ...current, [incoming.sessionId]: incoming };
}

/** Tracks the highest event sequence applied, so a replay can resume after it. */
export class MobileEventCursor {
  private latest: number;

  constructor(start = 0) {
    this.latest = start;
  }

  get sequence(): number {
    return this.latest;
  }

  /** Records an envelope; false when it was already seen (a duplicate delivery). */
  observe(sequence: number): boolean {
    if (!Number.isFinite(sequence) || sequence <= this.latest) return false;
    this.latest = sequence;
    return true;
  }

  reset(start = 0): void {
    this.latest = start;
  }
}
