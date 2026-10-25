import * as https from 'node:https';
import { exec } from 'node:child_process';
import type { ProviderUsageSnapshot, ProviderUsageWindow } from '@praxis/core';

interface AntigravityBucket {
  bucketId?: string;
  displayName?: string;
  description?: string;
  window?: string;
  remainingFraction?: number;
  resetTime?: string;
}

interface AntigravityGroup {
  displayName?: string;
  description?: string;
  buckets?: AntigravityBucket[];
}

interface AntigravityQuotaResponse {
  response?: {
    groups?: AntigravityGroup[];
    description?: string;
    userStatus?: {
      userTier?: string;
      creditType?: string;
      upgradeUrl?: string;
    };
  };
}

interface ServerConnectionInfo {
  port: number;
  csrfToken: string;
}

const CACHE_TTL_MS = 60 * 1000;
let cachedSnapshot: { at: number; snapshot: ProviderUsageSnapshot } | undefined;
let inFlightSnapshot: Promise<ProviderUsageSnapshot> | undefined;

function execAsync(cmd: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/**
 * Discover the running language_server process, its listening HTTPS port, and CSRF token.
 */
export async function discoverLanguageServer(): Promise<ServerConnectionInfo | undefined> {
  let psOutput = '';
  try {
    psOutput = await execAsync('ps -ww -eo pid,args');
  } catch {
    return undefined;
  }

  let pid: number | undefined;
  let csrfToken: string | undefined;

  for (const line of psOutput.split('\n')) {
    if (line.includes('language_server') && line.includes('--csrf_token')) {
      const pidMatch = line.trim().match(/^(\d+)/);
      const csrfMatch = line.match(/--csrf_token\s+([a-zA-Z0-9-]+)/);
      if (pidMatch && csrfMatch) {
        pid = parseInt(pidMatch[1], 10);
        csrfToken = csrfMatch[1];
        break;
      }
    }
  }

  if (!pid || !csrfToken) {
    return undefined;
  }

  // Find the listening ports for this process.
  let lsofOutput = '';
  try {
    lsofOutput = await execAsync(`lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`);
  } catch {
    return undefined;
  }

  const ports: number[] = [];
  for (const line of lsofOutput.split('\n')) {
    const match = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (match) {
      ports.push(parseInt(match[1], 10));
    }
  }

  if (ports.length === 0) {
    return undefined;
  }

  // Find the responsive port by querying the quota RPC.
  for (const port of ports) {
    try {
      await queryQuotaRpc(port, csrfToken, 2000);
      return { port, csrfToken };
    } catch {
      // Try next port.
    }
  }

  return undefined;
}

export function queryQuotaRpc(port: number, csrfToken: string, timeoutMs = 3000): Promise<AntigravityQuotaResponse> {
  return new Promise((resolve, reject) => {
    // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification -- 127.0.0.1 only: the local Antigravity language server uses a self-signed cert
    const options: https.RequestOptions = {
      hostname: '127.0.0.1',
      port,
      path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      method: 'POST',
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'x-codeium-csrf-token': csrfToken
      }
    };

    const req = https.request(options, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Antigravity quota RPC returned status ${res.statusCode}`));
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw) as AntigravityQuotaResponse);
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Antigravity quota RPC timed out'));
    });

    req.on('error', reject);
    req.write('{}');
    req.end();
  });
}

export function parseQuotaResponse(response: AntigravityQuotaResponse, fetchedAt: string): ProviderUsageSnapshot {
  const groups = response.response?.groups ?? [];
  const windows: ProviderUsageWindow[] = [];

  for (const group of groups) {
    const groupName = group.displayName || 'Antigravity';
    for (const bucket of group.buckets ?? []) {
      const remaining = typeof bucket.remainingFraction === 'number' ? bucket.remainingFraction : 1;
      const usedPercent = Math.min(100, Math.max(0, Math.round((1 - remaining) * 100)));
      const is5h = bucket.window === '5h' || bucket.bucketId?.includes('5h');
      const period = is5h ? 'hour' : 'week';
      const windowDurationMinutes = is5h ? 300 : 7 * 24 * 60;
      const label = `${groupName} (${is5h ? '5h' : 'Weekly'})`;

      windows.push({
        period,
        label,
        usedPercent,
        windowDurationMinutes,
        resetsAt: bucket.resetTime
      });
    }
  }

  // Sort windows: 5h windows first, then weekly windows.
  windows.sort((a, b) => (a.period === 'hour' ? -1 : 1) - (b.period === 'hour' ? -1 : 1));

  return {
    provider: 'antigravity-cli',
    fetchedAt,
    windows
  };
}

export async function antigravitySnapshot(): Promise<ProviderUsageSnapshot> {
  if (cachedSnapshot && Date.now() - cachedSnapshot.at < CACHE_TTL_MS) {
    return cachedSnapshot.snapshot;
  }

  inFlightSnapshot ??= (async (): Promise<ProviderUsageSnapshot> => {
    const fetchedAt = new Date().toISOString();
    try {
      const server = await discoverLanguageServer();
      if (!server) {
        return {
          provider: 'antigravity-cli',
          fetchedAt,
          windows: [],
          unavailableReason: 'Antigravity language server is not running or responsive.',
          unavailableReasonCode: 'cli-unavailable'
        };
      }

      const response = await queryQuotaRpc(server.port, server.csrfToken);
      const snapshot = parseQuotaResponse(response, fetchedAt);

      cachedSnapshot = { at: Date.now(), snapshot };
      return snapshot;
    } catch (err) {
      return {
        provider: 'antigravity-cli',
        fetchedAt,
        windows: [],
        unavailableReason: err instanceof Error ? err.message : 'Failed to query Antigravity quota.',
        unavailableReasonCode: 'fetch-failed'
      };
    }
  })().finally(() => {
    inFlightSnapshot = undefined;
  });

  return await inFlightSnapshot;
}
