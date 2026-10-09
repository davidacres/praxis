#!/usr/bin/env node
// Enforces the renderer's one hard rule about `@praxis/core`: **types only**.
//
// Core is CommonJS with no `sideEffects: false`, and pulls in `chokidar` /
// `markdown-it` (and, transitively, native bindings like `fsevents.node`) at
// module load. Vite/Rollup cannot tree-shake that out of a browser bundle —
// a single *value* import from `@praxis/core` anywhere in the renderer makes
// the bundler try to inline the whole package graph, and the build fails on
// a native binding it can't parse as JS.
//
// This used to be enforced only by AGENTS.md saying so. That failed exactly
// once: a real value import compiled clean under `tsc` (types don't care
// where a value comes from) and only broke `vite build`, which is easy to
// not run before trusting `tsc --noEmit`'s silence. This script parses every
// renderer source file with the TypeScript compiler API and fails fast,
// before Vite ever gets a chance to explain the problem as a corrupted
// binary three layers down.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const parser = require('@babel/parser');

const SRC_ROOT = path.join(__dirname, '..', 'src');
const BANNED_MODULE = '@praxis/core';

/** @param {string} dir @returns {string[]} */
function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** @param {string} filePath @returns {string[]} human-readable violation lines */
function checkFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const ast = parser.parse(text, {
    sourceType: 'module',
    plugins: ['typescript', 'jsx']
  });
  const violations = [];

  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration' && node.source.value === BANNED_MODULE) {
      if (node.importKind === 'type') continue;
      const line = node.loc ? node.loc.start.line : 1;
      const isValueImport =
        !node.specifiers ||
        node.specifiers.length === 0 ||
        node.specifiers.some(spec => spec.importKind !== 'type');
      if (isValueImport) {
        violations.push(`${path.relative(process.cwd(), filePath)}:${line}: value import from '${BANNED_MODULE}' — use \`import type\` only (see AGENTS.md: "The renderer imports types only from core at runtime").`);
      }
    }
  }
  return violations;
}

const violations = listSourceFiles(SRC_ROOT).flatMap(checkFile);
if (violations.length > 0) {
  console.error('checkCoreImports: found renderer imports that pull @praxis/core values into the browser bundle:\n');
  for (const line of violations) console.error(`  ${line}`);
  console.error('\nThis breaks `vite build` (it tries to bundle chokidar/native bindings) even though `tsc --noEmit` stays clean — see AGENTS.md.');
  process.exit(1);
}
