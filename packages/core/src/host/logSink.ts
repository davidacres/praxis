/**
 * A log destination shared by the backend services — anything with an
 * `appendLine` satisfies it (a console shim on desktop).
 */
export interface LogSink {
  appendLine(message: string): void;
}
