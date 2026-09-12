import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSarif,
  parseJUnitXml,
  parseCoverage,
  parseNpmAudit,
  parseOsvScanner,
  parseCheckResult,
  CheckResultParseError
} from './checkResultAdapters';

test('TASK-238: parseSarif maps SARIF 2.1.0 to CheckFindings', () => {
  const sarifFixture = JSON.stringify({
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'semgrep',
            rules: [
              {
                id: 'rules.detect-eval-with-expression',
                shortDescription: { text: 'Eval with dynamic argument' },
                properties: { 'security-severity': '8.5' }
              }
            ]
          }
        },
        results: [
          {
            ruleId: 'rules.detect-eval-with-expression',
            level: 'error',
            message: { text: 'Detected eval() execution with dynamic expression' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'src/eval.ts' },
                  region: { startLine: 42 }
                }
              }
            ]
          }
        ]
      }
    ]
  });

  const res = parseSarif(sarifFixture);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].severity, 'high');
  assert.equal(res.findings[0].file, 'src/eval.ts');
  assert.equal(res.findings[0].line, 42);
  assert.equal(res.findings[0].ruleId, 'rules.detect-eval-with-expression');
  assert.ok(res.findings[0].fingerprint.length > 0);
  assert.equal(res.metrics.findingsCount, 1);
  assert.equal(res.metrics.highCount, 1);

  // Malformed JSON fails with CheckResultParseError
  assert.throws(() => parseSarif('{ truncated: '), (err: any) => err instanceof CheckResultParseError);
});

test('TASK-238: parseJUnitXml maps JUnit XML to CheckFindings', () => {
  const junitFixture = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="unit-tests" tests="3" failures="1" errors="0" skipped="0">
  <testcase name="testAdd" classname="MathTests" file="tests/math.test.ts" line="10" />
  <testcase name="testSub" classname="MathTests" file="tests/math.test.ts" line="20" />
  <testcase name="testDivZero" classname="MathTests" file="tests/math.test.ts" line="30">
    <failure message="Expected division by zero error" type="AssertionError">
      at MathTests.testDivZero (tests/math.test.ts:32)
    </failure>
  </testcase>
</testsuite>`;

  const res = parseJUnitXml(junitFixture);
  assert.equal(res.metrics.tests, 3);
  assert.equal(res.metrics.passed, 2);
  assert.equal(res.metrics.failed, 1);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].severity, 'high');
  assert.equal(res.findings[0].file, 'tests/math.test.ts');
  assert.equal(res.findings[0].line, 30);
  assert.ok(res.findings[0].message.includes('testDivZero'));

  // Invalid report throws
  assert.throws(() => parseJUnitXml('not xml at all'), (err: any) => err instanceof CheckResultParseError);
});

test('TASK-238: parseCoverage handles both lcov and Cobertura formats', () => {
  const lcovFixture = `
TN:
SF:src/index.ts
DA:1,1
DA:2,1
DA:3,0
DA:4,1
LF:4
LH:3
end_of_record
`;

  const lcovRes = parseCoverage(lcovFixture);
  assert.equal(lcovRes.metrics.linesTotal, 4);
  assert.equal(lcovRes.metrics.linesHit, 3);
  assert.equal(lcovRes.metrics.lineCoveragePct, 75);
  assert.equal(lcovRes.metrics.newCodeCoveragePct, 75);

  const coberturaFixture = `<?xml version="1.0"?>
<coverage line-rate="0.82" branch-rate="0.70" lines-covered="82" lines-valid="100">
</coverage>`;

  const cobRes = parseCoverage(coberturaFixture);
  assert.equal(cobRes.metrics.linesTotal, 100);
  assert.equal(cobRes.metrics.linesHit, 82);
  assert.equal(cobRes.metrics.lineCoveragePct, 82);
  assert.equal(cobRes.metrics.newCodeCoveragePct, 82);

  assert.throws(() => parseCoverage('bad coverage data'), (err: any) => err instanceof CheckResultParseError);
});

test('TASK-238: parseNpmAudit maps npm audit v2 to CheckFindings', () => {
  const npmAuditFixture = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {
      minimist: {
        name: 'minimist',
        severity: 'critical',
        isDirect: true,
        via: ['Prototype Pollution'],
        effects: [],
        range: '<0.2.1 || >=1.0.0 <1.2.3',
        nodes: ['node_modules/minimist'],
        fixAvailable: true
      }
    },
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 1,
        total: 1
      }
    }
  });

  const res = parseNpmAudit(npmAuditFixture);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].severity, 'critical');
  assert.equal(res.findings[0].file, 'package-lock.json');
  assert.ok(res.findings[0].message.includes('minimist'));
  assert.equal(res.metrics.vulnerabilitiesCount, 1);
  assert.equal(res.metrics.criticalCount, 1);

  assert.throws(() => parseNpmAudit('invalid-json'), (err: any) => err instanceof CheckResultParseError);
});

test('TASK-238: parseOsvScanner maps osv-scanner output to CheckFindings', () => {
  const osvFixture = JSON.stringify({
    results: [
      {
        packageSource: { path: 'package-lock.json', type: 'lockfile' },
        packages: [
          {
            package: { name: 'semver', version: '5.7.1' },
            vulnerabilities: [
              {
                id: 'GHSA-c2qf-rxjj-qqgw',
                summary: 'semver vulnerable to Regular Expression Denial of Service',
                database_specific: {
                  severity: 'HIGH'
                }
              }
            ]
          }
        ]
      }
    ]
  });

  const res = parseOsvScanner(osvFixture);
  assert.equal(res.findings.length, 1);
  assert.equal(res.findings[0].severity, 'high');
  assert.equal(res.findings[0].ruleId, 'GHSA-c2qf-rxjj-qqgw');
  assert.ok(res.findings[0].message.includes('semver@5.7.1'));
  assert.equal(res.metrics.highCount, 1);

  // Dispatcher test
  const dispatched = parseCheckResult('osv-scanner', osvFixture);
  assert.equal(dispatched.findings.length, 1);
});
