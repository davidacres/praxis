/**
 * Host-neutral log destination shared by the ported backend services —
 * anything with an `appendLine` satisfies it (the extension's output channel,
 * a console shim on desktop).
 */
export interface LogSink {
  appendLine(message: string): void;
}
