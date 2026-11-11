#!/usr/bin/env node
// Generates crates/praxis-trackers/src/demo_fixtures.json from the compiled TypeScript
// DemoService (packages/core/out). Run `npm run build:core` first. Once the TypeScript demo
// service is retired this JSON becomes the source of truth and this script goes with it.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { DemoService } = require(path.join(root, 'packages/core/out/demo/demoService.js'));
const service = new DemoService({ getDefaultPageSize: () => 25 });
const data = JSON.parse(JSON.stringify({ issues: service.issues, boards: service.boards }));
const out = path.join(root, 'crates/praxis-trackers/src/demo_fixtures.json');
writeFileSync(out, `${JSON.stringify(data, null, 2)}\n`);
console.log(`wrote ${path.relative(root, out)}: ${data.issues.length} issues, ${data.boards.length} boards`);
