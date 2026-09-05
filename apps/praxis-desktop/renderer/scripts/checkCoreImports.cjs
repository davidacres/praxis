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
const ts = require('typescript');

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
  const source = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const violations = [];

  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === BANNED_MODULE) {
      const clause = node.importClause;
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const isValueImport =
        !clause ||
        (!clause.isTypeOnly &&
          ((clause.name && true) || // default import
            (clause.namedBindings &&
              (ts.isNamespaceImport(clause.namedBindings) || // `import * as x`
                (ts.isNamedImports(clause.namedBindings) &&
                  clause.namedBindings.elements.some(element => !element.isTypeOnly))))));
      if (isValueImport) {
        violations.push(`${path.relative(process.cwd(), filePath)}:${line}: value import from '${BANNED_MODULE}' — use \`import type\` only (see AGENTS.md: "The renderer imports types only from core at runtime").`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

const violations = listSourceFiles(SRC_ROOT).flatMap(checkFile);
if (violations.length > 0) {
  console.error('checkCoreImports: found renderer imports that pull @praxis/core values into the browser bundle:\n');
  for (const line of violations) console.error(`  ${line}`);
  console.error('\nThis breaks `vite build` (it tries to bundle chokidar/native bindings) even though `tsc --noEmit` stays clean — see AGENTS.md.');
  process.exit(1);
}
