import { spawn } from 'node:child_process';
import type { ProviderUsageSnapshot, ProviderUsageWindow } from '@praxis/core';

type RpcMessage = { id?: number; result?: unknown; error?: { message?: string } };

interface CodexRateWindow { usedPercent?: number; windowDurationMins?: number | null; resetsAt?: number | null }
interface CodexRateSnapshot {
  primary?: CodexRateWindow | null;
  secondary?: CodexRateWindow | null;
  credits?: { balance?: string | null; hasCredits?: boolean; unlimited?: boolean } | null;
  planType?: string | null;
  limitName?: string | null;
}
interface CodexTokenUsage { summary?: { lifetimeTokens?: number | null } }

function requestCodex(method: string, params: unknown, timeoutMs = 7000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buffer = '';
    let nextId = 1;
    let settled = false;
    let sendTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => finish(new Error('Codex app-server request timed out.')), timeoutMs);
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (sendTimer) clearTimeout(sendTimer);
      child.kill();
      if (error) reject(error); else resolve(value);
    };
    child.once('error', error => finish(new Error(`Codex CLI is unavailable: ${error.message}`)));
    // A CLI that exits early (missing, signed out, no `app-server` command)
    // closes the pipe under us; without these handlers the write below raises
    // an uncaught EPIPE in the main process instead of a "usage unavailable".
    child.stdin.on('error', error => finish(new Error(`Codex app-server closed its input: ${error.message}`)));
    child.once('exit', code => finish(new Error(`Codex app-server exited before answering (code ${code ?? 'unknown'}).`)));
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: RpcMessage;
        try { message = JSON.parse(line) as RpcMessage; } catch { continue; }
        if (message.id !== 1 && message.id !== 2) continue;
        if (message.error) finish(new Error(message.error.message ?? 'Codex app-server request failed.'));
        else if (message.id === 2) finish(undefined, message.result);
      }
    });
    const send = (id: number, name: string, body: unknown) => {
      if (settled || child.stdin.destroyed || !child.stdin.writable) return;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: name, params: body })}\n`);
    };
    send(1, 'initialize', { clientInfo: { name: 'praxis', version: '1.0.0' }, capabilities: null });
    // The account snapshot is available after initialize and uses no mutating request.
    sendTimer = setTimeout(() => send(2, method, params), 25);
  });
}

function mapWindow(period: 'hour' | 'week', label: string, value: CodexRateWindow | null | undefined): ProviderUsageWindow | undefined {
  if (!value) return undefined;
  return {
    period,
    label,
    usedPercent: typeof value.usedPercent === 'number' ? value.usedPercent : undefined,
    windowDurationMinutes: value.windowDurationMins ?? undefined,
    resetsAt: typeof value.resetsAt === 'number' ? new Date(value.resetsAt * 1000).toISOString() : undefined
  };
}

export async function codexCliSnapshot(): Promise<ProviderUsageSnapshot> {
  const fetchedAt = new Date().toISOString();
  try {
    const [response, usage] = await Promise.all([
      requestCodex('account/rateLimits/read', null) as Promise<{ rateLimits?: CodexRateSnapshot; rateLimitResetCredits?: { availableCount?: number } }>,
      requestCodex('account/usage/read', {}) as Promise<CodexTokenUsage>
    ]);
    const limits = response.rateLimits;
    if (!limits) return { provider: 'codex-cli', fetchedAt, windows: [], unavailableReason: 'Codex did not return account limits.' };
    const windows = [
      mapWindow('hour', '5-hour window', limits.primary),
      mapWindow('week', 'Weekly window', limits.secondary)
    ].filter((window): window is ProviderUsageWindow => Boolean(window));
    const availableResets = response.rateLimitResetCredits?.availableCount;
    return {
      provider: 'codex-cli',
      fetchedAt,
      windows,
      totalTokens: typeof usage.summary?.lifetimeTokens === 'number' ? usage.summary.lifetimeTokens : undefined,
      credits: typeof availableResets === 'number' ? { remaining: availableResets, currency: 'reset credits' } : undefined
    };
  } catch (error) {
    return { provider: 'codex-cli', fetchedAt, windows: [], unavailableReason: error instanceof Error ? error.message : 'Codex account usage is unavailable.' };
  }
}
