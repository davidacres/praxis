import { LogBus } from '@praxis/core';

let bus: LogBus | undefined;

/**
 * Shared main-process log bus. Ported backend services and the AI agent log
 * through tees of this bus; `logIpc` serves the buffer and live stream to the
 * renderer's Output panel.
 */
export function getLogBus(): LogBus {
  if (!bus) {
    bus = new LogBus();
  }
  return bus;
}
