import type { LogSink } from './logSink';

/**
 * Host-neutral log bus: a bounded ring buffer of recent lines plus fan-out to
 * subscribers. Hosts hand prefixed tees of the bus to ported services as their
 * `LogSink`, so everything those services log becomes visible to the host's
 * log UI (the desktop app's Output panel tails it over IPC).
 */
export class LogBus implements LogSink {
  private readonly lines: string[] = [];
  private readonly listeners = new Set<(line: string) => void>();

  constructor(private readonly capacity = 500) {}

  appendLine(message: string): void {
    const line = message.endsWith('\n') ? message.slice(0, -1) : message;
    this.lines.push(line);
    if (this.lines.length > this.capacity) {
      this.lines.splice(0, this.lines.length - this.capacity);
    }
    for (const listener of this.listeners) {
      try {
        listener(line);
      } catch {
        // A subscriber error (such as an IPC send during window teardown) must
        // never fail the bus or throw into the caller logging the message.
      }
    }
  }

  /** Snapshot of the buffered lines, oldest first. */
  recent(): string[] {
    return [...this.lines];
  }

  /** Subscribes to new lines; returns an unsubscribe function. */
  subscribe(listener: (line: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Returns a sink that writes through to this bus with a `[tag]` prefix and
   * optionally mirrors the prefixed line to another sink (e.g. the console).
   * Services keep their per-source prefixes without knowing about the bus.
   */
  tee(tag: string, also?: LogSink): LogSink {
    return {
      appendLine: message => {
        const line = `[${tag}] ${message}`;
        this.appendLine(line);
        also?.appendLine(line);
      }
    };
  }
}
