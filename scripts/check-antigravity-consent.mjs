#!/usr/bin/env node
// SEC-004 (PRX-F107 107-9): the Antigravity wrapper runs `agy` with every tool call
// auto-approved, so it may only append `--dangerously-skip-permissions` after refusing
// the turn unless Praxis passed explicit consent. Fails if any use of the flag is not
// preceded, in the same function, by that refusing gate.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FLAG = '--dangerously-skip-permissions';
const GATE = /^(\s*)if os\.environ\.get\("PRAXIS_ANTIGRAVITY_UNSAFE_AUTO_APPROVE"\) != "1":\s*$/;
const file = process.argv[2] ?? fileURLToPath(new URL('../packages/antigravity-acp/antigravity_acp/server.py', import.meta.url));
const lines = readFileSync(file, 'utf8').split('\n');
const indent = line => line.length - line.trimStart().length;

/** True when the gate's block (lines indented under it) ends the turn. */
function gateReturns(at) {
  const depth = indent(lines[at]);
  for (let i = at + 1; i < lines.length && (!lines[i].trim() || indent(lines[i]) > depth); i++) {
    if (/^\s*return\b/.test(lines[i])) return true;
  }
  return false;
}

const uses = lines.flatMap((line, i) => (line.includes(FLAG) ? [i] : []));
const failures = uses.filter(use => {
  for (let i = use - 1; i >= 0; i--) {
    if (/^\s*def /.test(lines[i])) return true;
    if (GATE.test(lines[i]) && gateReturns(i)) return false;
  }
  return true;
});

if (!uses.length) console.log(`${file}: ${FLAG} is no longer used.`);
for (const use of failures) console.error(`${file}:${use + 1}: ${FLAG} is not behind the PRAXIS_ANTIGRAVITY_UNSAFE_AUTO_APPROVE refusal.`);
process.exitCode = failures.length ? 1 : 0;
