#!/usr/bin/env node

/*
 * Deterministic inventory for Praxis Tests. The catalog is deliberately kept
 * outside Playwright runtime code: it can be checked before QA starts and it
 * can describe every test, including tests that fail before their assertions.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const repoRoot = path.resolve(__dirname, '../../../..');
const testRoot = path.join(repoRoot, 'apps/praxis-desktop/main/e2e');
const catalogDir = path.join(repoRoot, 'docs/praxis-tests');
const catalogPath = path.join(catalogDir, 'catalog.json');
const readmePath = path.join(catalogDir, 'index.md');

function sourceFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith('.spec.ts') ? [full] : [];
  }).sort();
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

function isTestCall(expression) {
  return ts.isIdentifier(expression) && expression.text === 'test';
}

function stableId(file, title) {
  const digest = crypto.createHash('sha1').update(`${file}\n${title}`).digest('hex').slice(0, 10).toUpperCase();
  return `PT-${digest}`;
}

function areaFor(file) {
  return path.basename(file, '.spec.ts').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ');
}

function collectTests() {
  const tests = [];
  for (const absolute of sourceFiles(testRoot)) {
    const relative = path.relative(repoRoot, absolute).split(path.sep).join('/');
    const source = fs.readFileSync(absolute, 'utf8');
    const file = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    function visit(node) {
      if (ts.isCallExpression(node) && isTestCall(node.expression)) {
        const title = literalText(node.arguments[0]);
        if (title) {
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
          tests.push({
            id: stableId(relative, title),
            title,
            source: { runner: 'playwright', file: relative, line, project: 'functional' },
            area: areaFor(relative),
            flow: {
              given: 'the Praxis desktop test fixture is prepared in an isolated application context',
              when: title,
              then: 'the automated assertions for this test pass and record the described user-visible result'
            }
          });
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
  }
  return tests.sort((a, b) => a.source.file.localeCompare(b.source.file) || a.source.line - b.source.line || a.title.localeCompare(b.title));
}

function buildCatalog(tests) {
  return {
    schemaVersion: 1,
    generatedBy: 'apps/praxis-desktop/main/scripts/praxis-test-catalog.cjs',
    runner: 'playwright',
    scope: 'apps/praxis-desktop/main/e2e',
    testCount: tests.length,
    tests
  };
}

function renderIndex(catalog) {
  const byArea = new Map();
  for (const test of catalog.tests) byArea.set(test.area, [...(byArea.get(test.area) || []), test]);
  const lines = [
    '# Praxis Test catalogue',
    '',
    `This catalogue describes **${catalog.testCount} Playwright tests** under \`${catalog.scope}\`. Each entry is a structured English contract linked to its exact source file and line. Run \`npm run test:praxis-contracts\` to detect drift before QA.`,
    '',
    '| ID | Area | Test | Automation |',
    '| --- | --- | --- | --- |'
  ];
  for (const test of catalog.tests) {
    lines.push(`| ${test.id} | ${test.area} | ${test.title.replace(/\|/g, '\\|')} | \`${test.source.file}:${test.source.line}\` |`);
  }
  lines.push('', '## Contract shape', '', 'Every entry carries **Given / When / Then** fields in `catalog.json`. The inventory is generated from the test source, so the count and links are deterministic; the Praxis Test Author agent can enrich individual flows where a test represents an important user journey.', '');
  return lines.join('\n');
}

function check() {
  const expected = buildCatalog(collectTests());
  if (!fs.existsSync(catalogPath)) {
    console.error(`Missing ${path.relative(repoRoot, catalogPath)}. Run with --write.`);
    process.exitCode = 1;
    return;
  }
  let actual;
  try { actual = JSON.parse(fs.readFileSync(catalogPath, 'utf8')); } catch (error) {
    console.error(`Invalid ${path.relative(repoRoot, catalogPath)}: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const expectedTests = JSON.stringify(expected.tests);
  const actualTests = JSON.stringify(actual.tests);
  if (expected.testCount !== actual.testCount || expectedTests !== actualTests) {
    console.error(`Praxis Test catalog is stale: expected ${expected.testCount} tests, found ${actual.testCount || 0}. Run with --write.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Praxis Tests: ${expected.testCount} Playwright tests catalogued and linked.`);
}

function write() {
  const catalog = buildCatalog(collectTests());
  fs.mkdirSync(catalogDir, { recursive: true });
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  fs.writeFileSync(readmePath, renderIndex(catalog));
  console.log(`Wrote ${catalog.testCount} Praxis Test contracts to ${path.relative(repoRoot, catalogDir)}.`);
}

if (process.argv.includes('--write')) write();
else check();
