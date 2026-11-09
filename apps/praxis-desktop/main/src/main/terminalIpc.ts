import { getRustHostBridge } from './rustHostInstance';
import type { CreateTerminalInput } from '@praxis/core';
import { getTerminalManager } from './terminalManager';
import { broadcastToAllWindows } from './windowBroadcast';

function broadcast(channel: string, payload: unknown): void {
  broadcastToAllWindows(channel, payload);
}

export function registerTerminalIpc(): void {
  const manager = getTerminalManager();
  const bridge = getRustHostBridge();
  manager.onOutput(event => broadcast('terminal:output', event));
  manager.onExit(event => broadcast('terminal:exit', event));
  manager.onContextAvailability(event => broadcast('terminal:contextAvailability', event));
  manager.onCommand(event => broadcast('terminal:command', event));

  bridge.handleOrFallback('terminal:listProfiles', () => manager.listProfiles());
  bridge.handleOrFallback('terminal:list', () => manager.list());
  bridge.handleOrFallback('terminal:create', (_event, input: CreateTerminalInput) => manager.create(input));
  bridge.handleOrFallback('terminal:write', (_event, sessionId: string, data: string) => manager.write(sessionId, data));
  bridge.handleOrFallback('terminal:resize', (_event, sessionId: string, cols: number, rows: number) => manager.resize(sessionId, cols, rows));
  bridge.handleOrFallback('terminal:kill', (_event, sessionId: string) => manager.kill(sessionId));
  bridge.handleOrFallback('terminal:getBuffer', (_event, sessionId: string) => manager.buffer(sessionId));
  bridge.handleOrFallback('terminal:getContext', (_event, sessionId: string) => manager.context(sessionId));
  bridge.handleOrFallback('terminal:listCommands', (_event, sessionId: string) => manager.commands(sessionId));
}
