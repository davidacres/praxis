import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import {
  isProviderLimitError,
  type ProviderUsageSnapshot,
  type ProviderUsageWindow
} from '@praxis/core';
import { getAiSessionManager } from './aiInstance';
import { parseClaudeUsageText } from './claudeUsageText';

interface ClaudeStatsCache {
  totalMessages?: number;
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  }>;
}

function extractResetNotice(text: string): string | undefined {
  const match = text.match(/resets\s+([^.\n]+)/i);
  return match ? `Resets ${match[1].trim()}` : undefined;
}

/** The windows move slowly and each read spawns the CLI, so reuse one for a few minutes. */
const WINDOWS_TTL_MS = 3 * 60 * 1000;
const WINDOWS_TIMEOUT_MS = 20_000;
let windowsCache: { at: number; windows: ProviderUsageWindow[] } | undefined;
let windowsInFlight: Promise<ProviderUsageWindow[]> | undefined;

/**
 * The 5-hour and weekly plan windows, read by asking Claude Code itself.
 * `/usage` is a local command (no model call), and going through the CLI means
 * Praxis never handles the login token. `--no-session-persistence` keeps the
 * probe out of the user's session history. Empty when the CLI is missing, the
 * login is an API key (no plan windows) or the reply does not parse.
 */
function readPlanWindows(): Promise<ProviderUsageWindow[]> {
  if (windowsCache && Date.now() - windowsCache.at < WINDOWS_TTL_MS) return Promise.resolve(windowsCache.windows);
  windowsInFlight ??= new Promise<ProviderUsageWindow[]>(resolve => {
    execFile(
      'claude',
      ['-p', '/usage', '--no-session-persistence'],
      { cwd: os.tmpdir(), timeout: WINDOWS_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        const windows = error ? [] : parseClaudeUsageText(stdout);
        // A failed read is not cached for the full TTL: a transient failure should retry soon.
        windowsCache = { at: windows.length > 0 ? Date.now() : Date.now() - WINDOWS_TTL_MS + 30_000, windows };
        resolve(windows);
      }
    );
  }).finally(() => { windowsInFlight = undefined; });
  return windowsInFlight;
}

export async function claudeCodeSnapshot(): Promise<ProviderUsageSnapshot> {
  const fetchedAt = new Date().toISOString();
  let lifetimeTokens: number | undefined;
  const planWindows = await readPlanWindows();

  try {
    const statsPath = path.join(os.homedir(), '.claude', 'stats-cache.json');
    const raw = await readFile(statsPath, 'utf8');
    const data = JSON.parse(raw) as ClaudeStatsCache;
    if (data.modelUsage && typeof data.modelUsage === 'object') {
      let total = 0;
      for (const usage of Object.values(data.modelUsage)) {
        total += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
      }
      if (total > 0) {
        lifetimeTokens = total;
      }
    }
  } catch {
    // Reading local stats cache is optional.
  }

  // Check if any active or recent Claude Code session recorded a limit error.
  const sessions = getAiSessionManager().getAllAgentSessions();
  const claudeSessions = [...sessions.values()].filter(
    s => s.provider === 'claude-code-cli'
  );
  const limitSession = claudeSessions.find(
    s => s.providerLimitReached || isProviderLimitError(s.lastError)
  );

  if (planWindows.length > 0) {
    return { provider: 'claude-code-cli', fetchedAt, windows: planWindows, totalTokens: lifetimeTokens };
  }

  if (limitSession?.lastError) {
    const resetNotice = extractResetNotice(limitSession.lastError);
    const windows: ProviderUsageWindow[] = [
      {
        period: 'hour',
        usedPercent: 100,
        label: resetNotice ?? 'Session limit reached'
      }
    ];

    // A session limit is a *result*, not an unavailability: we have real usage
    // data here. Putting the notice in `unavailableReason` made the card claim to
    // be offline while simultaneously showing a 100% window, so it gets its own
    // field and the window label carries the message.
    return {
      provider: 'claude-code-cli',
      fetchedAt,
      windows,
      totalTokens: lifetimeTokens
    };
  }

  return {
    provider: 'claude-code-cli',
    fetchedAt,
    windows: [],
    totalTokens: lifetimeTokens
  };
}
