import {
  callerHasCapability,
  type MobileCommand,
  type MobileCommandOperation,
  type MobileProtocolError,
} from './mobileProtocol';

export interface MobileExecutionHandlers {
  'sessions.create': (command: MobileCommand) => Promise<unknown>;
  'sessions.continue': (command: MobileCommand) => Promise<unknown>;
  'sessions.cancel': (command: MobileCommand) => Promise<unknown>;
  'sessions.configure': (command: MobileCommand) => Promise<unknown>;
  'workflowRuns.start': (command: MobileCommand) => Promise<unknown>;
  'workflowRuns.cancel': (command: MobileCommand) => Promise<unknown>;
  'workflowRuns.retryStage': (command: MobileCommand) => Promise<unknown>;
  'permissions.respond': (command: MobileCommand) => Promise<unknown>;
  'workflowGates.approve': (command: MobileCommand) => Promise<unknown>;
}

export type MobileExecutionResult =
  | { ok: true; value: unknown }
  | { ok: false; error: MobileProtocolError };

export async function dispatchMobileCommand(
  command: MobileCommand,
  handlers: MobileExecutionHandlers,
): Promise<MobileExecutionResult> {
  if (!callerHasCapability(command.caller, command.operation)) {
    return {
      ok: false,
      error: {
        code: 'forbidden',
        message: 'The caller is not authorised for this operation.',
        retryable: false,
        commandId: command.commandId,
      },
    };
  }

  const handler = handlers[command.operation as MobileCommandOperation];
  if (!handler) {
    return {
      ok: false,
      error: {
        code: 'not-found',
        message: `No execution handler is registered for ${command.operation}.`,
        retryable: false,
        commandId: command.commandId,
      },
    };
  }

  try {
    return { ok: true, value: await handler(command) };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'command-conflict',
        message: error instanceof Error ? error.message : 'Execution handler rejected the command.',
        retryable: true,
        commandId: command.commandId,
      },
    };
  }
}
