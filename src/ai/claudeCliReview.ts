import * as nodeChildProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { IssueDetails } from '../types';
import {
  AnalysisCancelledError,
  buildTicketContext,
  type ReviewStreamOptions
} from './aiReviewService';

const DEFAULT_MODEL = 'claude-opus-4-6';
const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function extractAssistantText(rawMessage: unknown): string | undefined {
  if (!isRecord(rawMessage)) {
    return undefined;
  }

  const content = rawMessage.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const chunks = content
    .map(item => {
      if (!isRecord(item) || item.type !== 'text') {
        return undefined;
      }
      return asString(item.text);
    })
    .filter((item): item is string => Boolean(item));

  if (chunks.length === 0) {
    return undefined;
  }

  return chunks.join('\n').trim() || undefined;
}

function resolveCliPath(cliPath: string | undefined): string {
  const trimmed = cliPath?.trim();
  if (trimmed) {
    return trimmed;
  }
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

function buildAnalysisArgs(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  sessionId: string
): string[] {
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--model',
    model,
    '--session-id',
    sessionId,
    '--system-prompt',
    systemPrompt,
    '--permission-mode',
    'bypassPermissions',
    '--dangerously-skip-permissions',
    userPrompt
  ];
}

export async function reviewTicketWithClaudeCli(
  issue: IssueDetails,
  cliPath: string | undefined,
  agentName: string,
  workingDirectory?: string,
  options?: ReviewStreamOptions
): Promise<string> {
  if (options?.signal?.aborted) {
    throw new AnalysisCancelledError();
  }

  const resolvedCliPath = resolveCliPath(cliPath);
  const model = options?.model?.trim() || DEFAULT_MODEL;
  const systemPrompt = options?.systemPrompt?.trim() || 'You are a senior software engineer analysing development tickets.';
  const ticketContext = buildTicketContext(issue);
  const userPrompt = `Please analyse this ticket:\n\n${ticketContext}`;
  const sessionId = randomUUID();

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutBuffer = '';
    let latestText = '';
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error, result?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      options?.signal?.removeEventListener('abort', onAbort);
      if (error) {
        reject(error);
        return;
      }
      resolve(result ?? '');
    };

    const onAbort = (): void => {
      try {
        child.kill();
      } catch {
        // Best-effort cancellation.
      }
      finish(new AnalysisCancelledError());
    };

    options?.signal?.addEventListener('abort', onAbort);

    const child = nodeChildProcess.spawn(
      resolvedCliPath,
      buildAnalysisArgs(systemPrompt, userPrompt, model, sessionId),
      {
        cwd: workingDirectory,
        detached: false,
        windowsHide: true
      }
    );

    timeoutHandle = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Ignore kill errors on timeout.
      }
      finish(new Error(`Claude Code CLI analysis timed out after ${Math.round(ANALYSIS_TIMEOUT_MS / 1000)}s.`));
    }, ANALYSIS_TIMEOUT_MS);

    const consumeLines = (): void => {
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let event: { type?: string; message?: unknown; result?: unknown; is_error?: boolean };
        try {
          event = JSON.parse(trimmed) as { type?: string; message?: unknown; result?: unknown; is_error?: boolean };
        } catch {
          continue;
        }

        if (event.type === 'assistant') {
          const text = extractAssistantText(event.message);
          if (text) {
            latestText = text;
            options?.onUpdate?.(`## AI Review by ${agentName}\n\n${latestText}`);
          }
          continue;
        }

        if (event.type === 'result') {
          const resultText = asString(event.result) ?? latestText;
          if (event.is_error) {
            finish(new Error(resultText || 'Claude Code CLI returned an error.'));
            return;
          }
          const trimmedResult = resultText.trim();
          if (!trimmedResult) {
            finish(new Error('Claude Code CLI returned an empty response.'));
            return;
          }
          finish(undefined, `## AI Review by ${agentName}\n\n${trimmedResult}`);
          return;
        }
      }
    };

    child.stdout.on('data', data => {
      stdoutBuffer += data.toString();
      consumeLines();
    });

    child.stderr.on('data', data => {
      const message = data.toString().trim();
      if (message) {
        // stderr is logged but does not fail analysis unless the process exits non-zero.
      }
    });

    child.on('error', error => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });

    child.on('close', code => {
      if (settled) {
        return;
      }

      if (stdoutBuffer.trim()) {
        stdoutBuffer += '\n';
        consumeLines();
      }

      if (code === 0 && latestText.trim()) {
        finish(undefined, `## AI Review by ${agentName}\n\n${latestText.trim()}`);
        return;
      }

      finish(new Error(
        code === 0
          ? 'Claude Code CLI returned an empty response.'
          : `Claude Code CLI exited with code ${code ?? 'unknown'}.`
      ));
    });
  });
}
