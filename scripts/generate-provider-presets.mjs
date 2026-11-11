#!/usr/bin/env node
// Generates crates/praxis-ai/src/providers/provider_presets.json from the compiled TypeScript
// catalog (packages/core/out). Run `npm run build:core` first. Once the TypeScript catalog is
// retired this JSON becomes the source of truth and this script goes with it.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { PROVIDER_PRESETS } = require(path.join(root, 'packages/core/out/ai/providers/providerPresets.js'));
const out = path.join(root, 'crates/praxis-ai/src/providers/provider_presets.json');
writeFileSync(out, `${JSON.stringify(PROVIDER_PRESETS, null, 2)}\n`);
console.log(`wrote ${path.relative(root, out)}: ${PROVIDER_PRESETS.length} presets`);
