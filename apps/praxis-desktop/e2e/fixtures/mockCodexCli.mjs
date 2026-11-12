#!/usr/bin/env node
// Stand-in for `codex app-server --stdio`, answering the two read-only account calls Praxis makes
// (`account/rateLimits/read`, `account/usage/read`) so the usage cards can be tested without a login.
import { createInterface } from 'node:readline';

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === 'initialize') reply(message.id, { userAgent: 'mock-codex' });
  else if (message.method === 'account/rateLimits/read') {
    reply(message.id, {
      rateLimits: {
        primary: { usedPercent: 41, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
        secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 * 3 }
      },
      rateLimitResetCredits: { availableCount: 2 }
    });
  } else if (message.method === 'account/usage/read') reply(message.id, { summary: { lifetimeTokens: 987654 } });
});
