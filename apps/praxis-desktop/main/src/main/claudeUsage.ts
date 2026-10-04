import * as os from 'node:os';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  isProviderLimitError,
  type ProviderUsageSnapshot,
  type ProviderUsageWindow
} from '@praxis/core';
import { getAiSessionManager } from './aiInstance';

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

export async function claudeCodeSnapshot(): Promise<ProviderUsageSnapshot> {
  const fetchedAt = new Date().toISOString();
  let lifetimeTokens: number | undefined;

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
