#!/usr/bin/env node
// Generates crates/praxis-core/src/agent_runtime/bundled.json from the compiled TypeScript
// definitions (packages/core/out). The Rust agent runtime embeds this file. Run
// `npm run build:core` first. Once the TypeScript definitions are retired this JSON becomes
// the source of truth and this script goes with them.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const bundled = require(path.join(root, 'packages/core/out/ai/agentRuntime/bundledAgents.js'));

const data = {
  // Agents mirrored into the user's agents folder and shown as built-in profiles.
  bundledAgents: bundled.BUNDLED_AGENT_DEFINITIONS,
  // Agents installable on demand (superset used for `builtIn` detection).
  availableAgents: bundled.AVAILABLE_AGENT_DEFINITIONS,
  availableSkills: bundled.AVAILABLE_SKILL_DEFINITIONS,
  // Skills written to every user's skills folder at startup.
  bundledSkillNames: [...bundled.BUNDLED_SKILL_NAMES]
};
const out = path.join(root, 'crates/praxis-core/src/agent_runtime/bundled.json');
writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
console.log(`wrote ${path.relative(root, out)}: ${Object.keys(data.bundledAgents).length} bundled agents, ${Object.keys(data.availableAgents).length} available agents, ${Object.keys(data.availableSkills).length} skills`);
