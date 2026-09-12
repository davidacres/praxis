/**
 * Result format adapters for deterministic checks (FX-BE-087 / TASK-238).
 *
 * Normalises SARIF 2.1.0, JUnit XML, lcov/Cobertura, npm audit --json and
 * osv-scanner --json into the closed `CheckFindings` shape:
 * - `findings`: stable fingerprint, file, line, severity, category, message, suggestion
 * - `metrics`: named numbers (e.g. lineCoveragePct, tests, passed, failed)
 *
 * Malformed, truncated, or unrecognised reports fail closed by throwing
 * `CheckResultParseError` — never silently passing as empty findings.
 */

import {
  computeFindingFingerprint,
  type CheckFinding,
  type CheckFindings,
  type CheckFindingSeverity,
  type CheckResultAdapterKind
} from './workflowTypes';

export class CheckResultParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'CheckResultParseError';
  }
}

// ── SARIF 2.1.0 ──────────────────────────────────────────────────────────

interface SarifRule {
  id: string;
  shortDescription?: { text?: string };
  defaultConfiguration?: { level?: string };
  properties?: {
    'security-severity'?: string | number;
    tags?: string[];
  };
}

interface SarifLocation {
  physicalLocation?: {
    artifactLocation?: { uri?: string };
    region?: { startLine?: number };
  };
}

interface SarifResult {
  ruleId?: string;
  level?: string;
  message?: { text?: string; markdown?: string };
  locations?: SarifLocation[];
  properties?: {
    'security-severity'?: string | number;
    issue_confidence?: string;
  };
  fixes?: Array<{ description?: { text?: string } }>;
}

interface SarifRun {
  tool?: {
    driver?: {
      name?: string;
      rules?: SarifRule[];
    };
  };
  results?: SarifResult[];
}

interface SarifReport {
  version?: string;
  $schema?: string;
  runs?: SarifRun[];
}

export function parseSarif(raw: string): CheckFindings {
  if (!raw.trim()) {
    throw new CheckResultParseError('SARIF report is empty.');
  }

  let doc: SarifReport;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new CheckResultParseError(`Malformed SARIF JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.runs)) {
    throw new CheckResultParseError('Invalid SARIF: missing "runs" array.');
  }

  const findings: CheckFinding[] = [];
  const metrics: Record<string, number> = {
    findingsCount: 0,
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    infoCount: 0
  };

  for (const run of doc.runs) {
    const rulesMap = new Map<string, SarifRule>();
    for (const rule of run.tool?.driver?.rules ?? []) {
      if (rule.id) rulesMap.set(rule.id, rule);
    }
    const toolName = run.tool?.driver?.name || 'sarif';

    for (const result of run.results ?? []) {
      const rule = result.ruleId ? rulesMap.get(result.ruleId) : undefined;
      const ruleId = result.ruleId || 'unknown-rule';

      // Security severity score takes precedence if available
      const secScoreRaw = result.properties?.['security-severity'] ?? rule?.properties?.['security-severity'];
      const secScore = typeof secScoreRaw === 'string' ? parseFloat(secScoreRaw) : typeof secScoreRaw === 'number' ? secScoreRaw : undefined;

      let severity: CheckFindingSeverity;
      if (secScore !== undefined && !Number.isNaN(secScore)) {
        if (secScore >= 9.0) severity = 'critical';
        else if (secScore >= 7.0) severity = 'high';
        else if (secScore >= 4.0) severity = 'medium';
        else if (secScore > 0.0) severity = 'low';
        else severity = 'info';
      } else {
        const level = result.level || rule?.defaultConfiguration?.level || 'warning';
        switch (level) {
          case 'error':
            severity = 'high';
            break;
          case 'warning':
            severity = 'medium';
            break;
          case 'note':
            severity = 'low';
            break;
          case 'none':
          default:
            severity = 'info';
            break;
        }
      }

      const loc = result.locations?.[0]?.physicalLocation;
      const file = loc?.artifactLocation?.uri;
      const line = loc?.region?.startLine;
      const message = result.message?.text || result.message?.markdown || 'Finding reported by SARIF.';
      const category = rule?.shortDescription?.text || toolName;
      const suggestion = result.fixes?.[0]?.description?.text;

      const finding: CheckFinding = {
        fingerprint: computeFindingFingerprint({ ruleId, file, line, message }),
        ruleId,
        file,
        line,
        severity,
        category,
        message,
        suggestion
      };

      findings.push(finding);
      metrics.findingsCount++;
      metrics[`${severity}Count`]++;
    }
  }

  return { findings, metrics };
}

// ── JUnit XML ────────────────────────────────────────────────────────────

export function parseJUnitXml(raw: string): CheckFindings {
  if (!raw.trim()) {
    throw new CheckResultParseError('JUnit report is empty.');
  }

  if (!raw.includes('<testcase') && !raw.includes('<testsuite') && !raw.includes('<testsuites')) {
    throw new CheckResultParseError('Invalid JUnit XML: missing testsuite/testcase elements.');
  }

  const findings: CheckFinding[] = [];
  let totalTests = 0;
  let totalFailures = 0;
  let totalErrors = 0;
  let totalSkipped = 0;

  // Extract all testcases
  const testcaseRegex = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let tcMatch: RegExpExecArray | null;

  while ((tcMatch = testcaseRegex.exec(raw)) !== null) {
    totalTests++;
    const attrs = tcMatch[1];
    const body = tcMatch[3] ?? '';

    const nameMatch = /\bname="([^"]*)"/.exec(attrs);
    const classMatch = /\bclassname="([^"]*)"/.exec(attrs);
    const fileMatch = /\bfile="([^"]*)"/.exec(attrs);
    const lineMatch = /\bline="([^"]*)"/.exec(attrs);

    const testName = nameMatch ? nameMatch[1] : `test-${totalTests}`;
    const className = classMatch ? classMatch[1] : undefined;
    const file = fileMatch ? fileMatch[1] : className?.replace(/\./g, '/') + '.ts';
    const line = lineMatch ? parseInt(lineMatch[1], 10) : undefined;

    // Check for failure or error inside testcase
    const failureMatch = /<failure\b([^>]*?)>([\s\S]*?)<\/failure>|<failure\b([^>]*?)\/>/.exec(body);
    const errorMatch = /<error\b([^>]*?)>([\s\S]*?)<\/error>|<error\b([^>]*?)\/>/.exec(body);
    const skippedMatch = /<skipped\b/.test(body);

    if (skippedMatch) {
      totalSkipped++;
    } else if (failureMatch || errorMatch) {
      const isError = Boolean(errorMatch);
      if (isError) totalErrors++;
      else totalFailures++;

      const match = errorMatch || failureMatch;
      const typeMatch = /\btype="([^"]*)"/.exec(match?.[1] ?? '');
      const msgMatch = /\bmessage="([^"]*)"/.exec(match?.[1] ?? '');
      const bodyText = (match?.[2] ?? '').trim();
      const failMsg = msgMatch ? msgMatch[1] : bodyText.split('\n')[0] || (isError ? 'Test error' : 'Test failure');

      const ruleId = typeMatch ? typeMatch[1] : isError ? 'test-error' : 'test-failure';
      const message = `${testName}: ${failMsg}`;

      findings.push({
        fingerprint: computeFindingFingerprint({ ruleId, file, line, message }),
        ruleId,
        file,
        line,
        severity: isError ? 'critical' : 'high',
        category: 'test-failure',
        message
      });
    }
  }

  // If no testcase tags were found, look at root testsuite attributes
  if (totalTests === 0) {
    const suiteMatch = /<testsuite\b([^>]*)>/.exec(raw);
    if (suiteMatch) {
      const testsAttr = /\btests="(\d+)"/.exec(suiteMatch[1]);
      const failAttr = /\bfailures="(\d+)"/.exec(suiteMatch[1]);
      const errAttr = /\berrors="(\d+)"/.exec(suiteMatch[1]);
      const skipAttr = /\bskipped="(\d+)"/.exec(suiteMatch[1]);
      if (testsAttr) totalTests = parseInt(testsAttr[1], 10);
      if (failAttr) totalFailures = parseInt(failAttr[1], 10);
      if (errAttr) totalErrors = parseInt(errAttr[1], 10);
      if (skipAttr) totalSkipped = parseInt(skipAttr[1], 10);
    }
  }

  const passedTests = Math.max(0, totalTests - totalFailures - totalErrors - totalSkipped);
  const passPct = totalTests > 0 ? (passedTests / totalTests) * 100 : 100;

  return {
    findings,
    metrics: {
      tests: totalTests,
      passed: passedTests,
      failed: totalFailures + totalErrors,
      skipped: totalSkipped,
      passPct: Math.round(passPct * 100) / 100
    }
  };
}

// ── Coverage (lcov + Cobertura) ──────────────────────────────────────────

export function parseCoverage(raw: string): CheckFindings {
  if (!raw.trim()) {
    throw new CheckResultParseError('Coverage report is empty.');
  }

  // Cobertura XML detection
  if (raw.includes('<coverage') || raw.includes('<!DOCTYPE coverage')) {
    return parseCoberturaXml(raw);
  }

  // lcov format detection
  if (raw.includes('TN:') || raw.includes('SF:') || raw.includes('end_of_record')) {
    return parseLcov(raw);
  }

  throw new CheckResultParseError('Unrecognised coverage format: expected lcov or Cobertura XML.');
}

function parseLcov(raw: string): CheckFindings {
  let linesFound = 0;
  let linesHit = 0;
  let branchesFound = 0;
  let branchesHit = 0;
  let records = 0;

  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('SF:')) {
      records++;
    } else if (trimmed.startsWith('LF:')) {
      linesFound += parseInt(trimmed.slice(3).trim(), 10) || 0;
    } else if (trimmed.startsWith('LH:')) {
      linesHit += parseInt(trimmed.slice(3).trim(), 10) || 0;
    } else if (trimmed.startsWith('BRF:')) {
      branchesFound += parseInt(trimmed.slice(4).trim(), 10) || 0;
    } else if (trimmed.startsWith('BRH:')) {
      branchesHit += parseInt(trimmed.slice(4).trim(), 10) || 0;
    }
  }

  if (records === 0 && linesFound === 0) {
    throw new CheckResultParseError('Invalid lcov report: no SF or LF records found.');
  }

  const lineCoveragePct = linesFound > 0 ? (linesHit / linesFound) * 100 : 100;
  const branchCoveragePct = branchesFound > 0 ? (branchesHit / branchesFound) * 100 : 100;

  return {
    findings: [],
    metrics: {
      linesTotal: linesFound,
      linesHit,
      lineCoveragePct: Math.round(lineCoveragePct * 100) / 100,
      newCodeCoveragePct: Math.round(lineCoveragePct * 100) / 100,
      branchesTotal: branchesFound,
      branchesHit,
      branchCoveragePct: Math.round(branchCoveragePct * 100) / 100
    }
  };
}

function parseCoberturaXml(raw: string): CheckFindings {
  const lineRateMatch = /\bline-rate="([0-9.]+)"/.exec(raw);
  const branchRateMatch = /\bbranch-rate="([0-9.]+)"/.exec(raw);
  const linesValidMatch = /\blines-valid="([0-9]+)"/.exec(raw);
  const linesCoveredMatch = /\blines-covered="([0-9]+)"/.exec(raw);

  if (!lineRateMatch) {
    throw new CheckResultParseError('Invalid Cobertura XML: missing line-rate attribute.');
  }

  const lineRate = parseFloat(lineRateMatch[1]);
  const branchRate = branchRateMatch ? parseFloat(branchRateMatch[1]) : lineRate;
  const lineCoveragePct = Math.round(lineRate * 10000) / 100;
  const branchCoveragePct = Math.round(branchRate * 10000) / 100;

  return {
    findings: [],
    metrics: {
      linesTotal: linesValidMatch ? parseInt(linesValidMatch[1], 10) : 0,
      linesHit: linesCoveredMatch ? parseInt(linesCoveredMatch[1], 10) : 0,
      lineCoveragePct,
      newCodeCoveragePct: lineCoveragePct,
      branchCoveragePct
    }
  };
}

// ── npm audit --json ─────────────────────────────────────────────────────

export function parseNpmAudit(raw: string): CheckFindings {
  if (!raw.trim()) {
    throw new CheckResultParseError('npm audit report is empty.');
  }

  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new CheckResultParseError(`Malformed npm audit JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!doc || typeof doc !== 'object') {
    throw new CheckResultParseError('Invalid npm audit format: expected JSON object.');
  }

  const findings: CheckFinding[] = [];
  const metrics: Record<string, number> = {
    vulnerabilitiesCount: 0,
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    infoCount: 0
  };

  // v2 format: doc.vulnerabilities Record<string, Vulnerability>
  if (doc.vulnerabilities && typeof doc.vulnerabilities === 'object') {
    for (const [pkgName, vuln] of Object.entries<any>(doc.vulnerabilities)) {
      const rawSev = String(vuln.severity || 'moderate').toLowerCase();
      let severity: CheckFindingSeverity;
      switch (rawSev) {
        case 'critical':
          severity = 'critical';
          break;
        case 'high':
          severity = 'high';
          break;
        case 'moderate':
        case 'medium':
          severity = 'medium';
          break;
        case 'low':
          severity = 'low';
          break;
        default:
          severity = 'info';
          break;
      }

      const ruleId = `npm-audit-${pkgName}`;
      const message = `${pkgName}: ${vuln.range || ''} (${rawSev} severity dependency vulnerability)`;
      const file = 'package-lock.json';

      findings.push({
        fingerprint: computeFindingFingerprint({ ruleId, file, message }),
        ruleId,
        file,
        severity,
        category: 'dependency-vulnerability',
        message,
        suggestion: vuln.fixAvailable ? `Run npm audit fix or update ${pkgName}` : undefined
      });

      metrics.vulnerabilitiesCount++;
      metrics[`${severity}Count`]++;
    }
  } else if (doc.advisories && typeof doc.advisories === 'object') {
    // v1 format: doc.advisories
    for (const adv of Object.values<any>(doc.advisories)) {
      const rawSev = String(adv.severity || 'moderate').toLowerCase();
      let severity: CheckFindingSeverity;
      switch (rawSev) {
        case 'critical':
          severity = 'critical';
          break;
        case 'high':
          severity = 'high';
          break;
        case 'moderate':
        case 'medium':
          severity = 'medium';
          break;
        case 'low':
          severity = 'low';
          break;
        default:
          severity = 'info';
          break;
      }

      const ruleId = adv.cwe || `advisory-${adv.id}`;
      const message = `${adv.module_name}: ${adv.title}`;
      const file = 'package-lock.json';

      findings.push({
        fingerprint: computeFindingFingerprint({ ruleId, file, message }),
        ruleId,
        file,
        severity,
        category: 'dependency-vulnerability',
        message,
        suggestion: adv.recommendation
      });

      metrics.vulnerabilitiesCount++;
      metrics[`${severity}Count`]++;
    }
  } else if (!doc.metadata && !doc.auditReportVersion) {
    throw new CheckResultParseError('Unrecognised npm audit structure: missing vulnerabilities or advisories.');
  }

  return { findings, metrics };
}

// ── osv-scanner --json ───────────────────────────────────────────────────

export function parseOsvScanner(raw: string): CheckFindings {
  if (!raw.trim()) {
    throw new CheckResultParseError('osv-scanner report is empty.');
  }

  let doc: any;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new CheckResultParseError(`Malformed osv-scanner JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!doc || typeof doc !== 'object' || (!Array.isArray(doc.results) && !Array.isArray(doc.packages))) {
    throw new CheckResultParseError('Invalid osv-scanner format: expected results or packages array.');
  }

  const findings: CheckFinding[] = [];
  const metrics: Record<string, number> = {
    vulnerabilitiesCount: 0,
    criticalCount: 0,
    highCount: 0,
    mediumCount: 0,
    lowCount: 0,
    infoCount: 0
  };

  const results = Array.isArray(doc.results) ? doc.results : [{ packages: doc.packages }];

  for (const group of results) {
    const file = group.packageSource?.path || 'package-lock.json';

    for (const pkgItem of group.packages ?? []) {
      const pkg = pkgItem.package ?? {};
      const pkgName = pkg.name || 'unknown-package';
      const pkgVersion = pkg.version ? `@${pkg.version}` : '';

      for (const vuln of pkgItem.vulnerabilities ?? []) {
        const id = vuln.id || 'OSV-VULN';
        const rawSev = String(vuln.database_specific?.severity || vuln.severity?.[0]?.score || 'MEDIUM').toUpperCase();

        let severity: CheckFindingSeverity;
        if (rawSev.includes('CRITICAL')) severity = 'critical';
        else if (rawSev.includes('HIGH')) severity = 'high';
        else if (rawSev.includes('LOW')) severity = 'low';
        else if (rawSev.includes('MODERATE') || rawSev.includes('MEDIUM')) severity = 'medium';
        else severity = 'info';

        const summary = vuln.summary || vuln.details || 'Vulnerability detected by osv-scanner';
        const message = `${pkgName}${pkgVersion}: ${summary}`;

        findings.push({
          fingerprint: computeFindingFingerprint({ ruleId: id, file, message }),
          ruleId: id,
          file,
          severity,
          category: 'dependency-vulnerability',
          message,
          suggestion: vuln.database_specific?.recommendation
        });

        metrics.vulnerabilitiesCount++;
        metrics[`${severity}Count`]++;
      }
    }
  }

  return { findings, metrics };
}

// ── Generic Adapter Dispatcher ───────────────────────────────────────────

export function parseCheckResult(adapter: CheckResultAdapterKind, raw: string): CheckFindings {
  switch (adapter) {
    case 'sarif':
      return parseSarif(raw);
    case 'junit':
      return parseJUnitXml(raw);
    case 'lcov':
    case 'cobertura':
      return parseCoverage(raw);
    case 'npm-audit':
      return parseNpmAudit(raw);
    case 'osv-scanner':
      return parseOsvScanner(raw);
    default:
      throw new CheckResultParseError(`Unsupported check result adapter: ${String(adapter)}`);
  }
}
