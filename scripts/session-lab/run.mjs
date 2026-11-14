#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [mode, ...args] = process.argv.slice(2);
if (!['capture','replay','provider'].includes(mode) || args.includes('--help')) {
  console.log('Usage: node scripts/session-lab/run.mjs capture|replay|provider [--model ID] [--provider ID] [--command PATH] [--args JSON] [--effort medium] [--out DIR] [--bundle FILE] [--headed] [--hold SECONDS] [--scenario FILE] [--tool-mode read-only] [--permission manual] [--speed 4]');
  process.exit(args.includes('--help') ? 0 : 1);
}
const env = { ...process.env, PRAXIS_SESSION_LAB_MODE: mode };
const flags = { '--model': 'MODEL', '--provider': 'PROVIDER', '--command': 'COMMAND', '--args': 'ARGS', '--effort': 'EFFORT', '--out': 'OUT', '--bundle': 'BUNDLE', '--hold': 'HOLD', '--scenario': 'SCENARIO', '--tool-mode': 'TOOL_MODE', '--permission': 'PERMISSION', '--speed': 'SPEED' };
let headed = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--headed') { headed = true; continue; }
  const key = flags[args[i]];
  if (!key || !args[i+1]) throw new Error(`Invalid option: ${args[i]}`);
  env[`PRAXIS_SESSION_LAB_${key}`] = args[++i];
}
for (const key of ['SPEED','HOLD']) {
  const value = env[`PRAXIS_SESSION_LAB_${key}`];
  if (value !== undefined && (!Number.isFinite(Number(value)) || Number(value) < (key === 'SPEED' ? 0.01 : 0))) throw new Error(`Invalid ${key.toLowerCase()}`);
}
if (mode !== 'capture' && !env.PRAXIS_SESSION_LAB_BUNDLE) throw new Error('--bundle is required for replay');
if (headed) env.PRAXIS_SESSION_LAB_HEADED = '1';
const result = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['playwright', 'test', '-c', 'apps/praxis-desktop/playwright.config.ts', '--project=live-agent', 'sessionLab.live.spec.ts', '--workers=1', '--output', path.join(root, 'output/playwright/session-lab/test-results', String(process.pid)), ...(headed ? ['--headed'] : [])], {cwd:root, env, stdio:'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
