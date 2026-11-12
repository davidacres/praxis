#!/usr/bin/env node
// Stand-in for `claude -p /usage`: prints the plan-usage lines Claude Code prints, with no model call.
if (process.argv.includes('/usage')) {
  process.stdout.write([
    'You are currently using your subscription to power your Claude Code usage',
    '',
    'Current session: 23% used · resets 11pm (UTC)',
    'Current week (all models): 35% used · resets Dec 31 at 9am (UTC)',
    ''
  ].join('\n'));
}
