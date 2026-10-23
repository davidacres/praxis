#!/usr/bin/env node

/*
 * Deterministic inventory for Praxis Tests. The catalog is deliberately kept
 * outside Playwright runtime code: it can be checked before QA starts and it
 * can describe every test, including tests that fail before their assertions.
 *
 * The catalog mixes generated data (id, title, source location, project) with
 * curated prose (the Given / When / Then flow). Only the generated data is
 * compared for staleness; curated flows are preserved by --write and validated
 * for shape, never for wording. Line numbers are location hints, not identity:
 * drift there is reported as a warning rather than a failure.
 *
 * Known limitations, intentionally out of scope here:
 *   - tests whose title is a template literal with expressions are skipped,
 *     so parameterized cases are under-counted;
 *   - every entry is labelled project "functional" instead of being derived
 *     from playwright.config.ts, so themes and live-agent specs are misattributed.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const parser = require('@babel/parser');

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
  if (node?.type === 'StringLiteral') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

function isTestCall(expression) {
  return expression?.type === 'Identifier' && expression.name === 'test';
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
    const file = parser.parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
    function visit(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && isTestCall(node.callee)) {
        const title = literalText(node.arguments[0]);
        if (title) {
          const line = node.loc.start.line;
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
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) value.forEach(visit);
        else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value);
      }
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
  lines.push(
    '',
    '## Contract shape',
    '',
    'Every entry carries **Given / When / Then** fields in `catalog.json`. The inventory is generated from the test source, so the count and links are deterministic.',
    '',
    'The Praxis Test Author agent may enrich any entry\'s `flow` prose where a test represents an important user journey. Hand-written prose is never reported stale: `npm run test:praxis-contracts -- --write` carries it over by id. Only the generated identity (id, title, file, project) must match the test source; a moved line number is a warning, not a failure.',
    '',
    'Known gaps in the generated inventory: tests whose title is a template literal with expressions are skipped, so parameterized cases are not counted, and every entry is labelled `project: functional` regardless of the Playwright project that actually runs it.',
    ''
  );
  return lines.join('\n');
}

function location(test) {
  return `${test.source?.file ?? '?'}:${test.source?.line ?? '?'}`;
}

function isFilled(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalidFlows(tests) {
  return tests
    .filter(test => !test.flow || !isFilled(test.flow.given) || !isFilled(test.flow.when) || !isFilled(test.flow.then))
    .map(test => `${test.id} (${location(test)})`);
}

/*
 * Compare generated identity only: id, title, file, project. Curated prose is
 * deliberately absent from this comparison so hand-written contracts survive
 * regeneration. Line drift is separated out because it is churn, not staleness.
 */
function diffCatalogs(expected, actual) {
  const expectedById = new Map(expected.map(test => [test.id, test]));
  const actualById = new Map(actual.map(test => [test.id, test]));
  const added = [];
  const removed = [];
  const moved = [];
  const mismatched = [];
  for (const [id, test] of expectedById) {
    const existing = actualById.get(id);
    if (!existing) { added.push(test); continue; }
    const changed = existing.title !== test.title
      || existing.source?.file !== test.source?.file
      || existing.source?.project !== test.source?.project;
    if (changed) mismatched.push({ test, existing });
    else if (existing.source?.line !== test.source?.line) moved.push({ test, existing });
  }
  for (const [id, test] of actualById) if (!expectedById.has(id)) removed.push(test);
  // An id is derived from the title, so a rename shows up as one removal plus
  // one addition at the same location. Report it as a rename instead.
  const renames = [];
  for (const addedTest of added) {
    const twin = removed.find(candidate => candidate.source?.file === addedTest.source?.file && candidate.source?.line === addedTest.source?.line);
    if (twin) renames.push({ from: twin, to: addedTest });
  }
  const renamedIds = new Set(renames.flatMap(rename => [rename.from.id, rename.to.id]));
  return {
    added: added.filter(test => !renamedIds.has(test.id)),
    removed: removed.filter(test => !renamedIds.has(test.id)),
    moved,
    mismatched,
    renames
  };
}

function readCatalog() {
  if (!fs.existsSync(catalogPath)) return { error: `Missing ${path.relative(repoRoot, catalogPath)}. Run with --write.` };
  try {
    const parsed = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    return { catalog: parsed, tests: Array.isArray(parsed.tests) ? parsed.tests : [] };
  } catch (error) {
    return { error: `Invalid ${path.relative(repoRoot, catalogPath)}: ${error.message}` };
  }
}

function check() {
  const expected = collectTests();
  const { catalog, tests: actual, error } = readCatalog();
  if (error) {
    console.error(error);
    process.exitCode = 1;
    return;
  }
  const diff = diffCatalogs(expected, actual);
  const invalid = invalidFlows(actual);
  const countMismatch = catalog.testCount !== actual.length
    ? [`testCount says ${catalog.testCount} but the file holds ${actual.length} entries`]
    : [];
  const fatal = [...countMismatch, ...diff.mismatched.map(entry => `${entry.test.id} differs from the catalogued contract: "${entry.existing.title}" at ${location(entry.existing)} is now "${entry.test.title}" at ${location(entry.test)}`), ...diff.renames.map(rename => `renamed: "${rename.from.title}" (${location(rename.from)}) is now "${rename.to.title}" (id ${rename.from.id} -> ${rename.to.id})`), ...diff.added.map(test => `new test not in the catalog: "${test.title}" (${location(test)})`), ...diff.removed.map(test => `catalogued test no longer exists: "${test.title}" (${location(test)})`), ...invalid.map(entry => `contract is missing Given/When/Then prose: ${entry}`)];
  if (fatal.length > 0) {
    console.error(`Praxis Test catalog is stale (${fatal.length} problem${fatal.length === 1 ? '' : 's'}):`);
    for (const problem of fatal) console.error(`  - ${problem}`);
    console.error(`Run \`npm run test:praxis-contracts -- --write\` to regenerate. Curated Given/When/Then prose is preserved.`);
    process.exitCode = 1;
    return;
  }
  if (diff.moved.length > 0) {
    console.warn(`Praxis Test catalog: ${diff.moved.length} entr${diff.moved.length === 1 ? 'y has' : 'ies have'} moved in the source; run --write to refresh the links.`);
    for (const { test, existing } of diff.moved) {
      console.warn(`  - ${test.id} ${existing.source.file}: ${existing.source.line} -> ${test.source.line}`);
    }
  }
  console.log(`Praxis Tests: ${expected.length} Playwright tests catalogued and linked.`);
}

/*
 * Regenerate the inventory but keep any curated flow already attached to an id,
 * so enriching a contract never makes the catalog look stale.
 */
function write() {
  const curated = new Map();
  const { tests: existing } = readCatalog();
  for (const test of existing) if (test.id && test.flow) curated.set(test.id, test.flow);
  const tests = collectTests().map(test => (curated.has(test.id) ? { ...test, flow: curated.get(test.id) } : test));
  const catalog = buildCatalog(tests);
  fs.mkdirSync(catalogDir, { recursive: true });
  fs.writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  fs.writeFileSync(readmePath, renderIndex(catalog));
  const carried = tests.filter(test => curated.has(test.id)).length;
  console.log(`Wrote ${catalog.testCount} Praxis Test contracts to ${path.relative(repoRoot, catalogDir)} (${carried} existing contract${carried === 1 ? '' : 's'} carried over).`);
}

if (process.argv.includes('--write')) write();
else check();
