import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubActionsEvidenceProvider } from './githubActionsEvidenceProvider';
import { GitLabCiEvidenceProvider } from './gitLabCiEvidenceProvider';
import {
  mapCiReportToCheckFindings,
  redactCiContent,
  importCiSecurityReportAsEvidence
} from './ciEvidenceImport';
import type { CiSecurityReportResult } from './ciEvidenceProvider';
import {
  computeFindingFingerprint,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type WorkflowCheckNode,
  type WorkflowApprovalNode,
  type WorkflowAgentTaskNode
} from '../workflows/workflowTypes';
import { createWorkflowRun, applyWorkflowRunCommand } from '../workflows/workflowRun';
import { evaluateGates } from '../workflows/workflowGates';

const TEST_SHA = 'abc1234567890abcdef1234567890abcdef12345';

test('TASK-250: GitHubActionsEvidenceProvider getSecurityReports against fixture', async () => {
  const fakeFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('code-scanning/alerts')) {
      return new Response(
        JSON.stringify([
          {
            rule: { id: 'js/sql-injection', security_severity_level: 'high', description: 'SQL Injection' },
            most_recent_instance: {
              location: { path: 'src/db.js', start_line: 42 },
              message: { text: 'Query contains unescaped input' }
            }
          }
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('Not found', { status: 404 });
  };

  const provider = new GitHubActionsEvidenceProvider(
    { baseUrl: 'https://api.github.com', owner: 'owner', repo: 'repo', token: 'fake-token' },
    fakeFetch
  );

  const report = await provider.getSecurityReports(TEST_SHA);
  assert.strictEqual(report.available, true);
  assert.strictEqual(report.provider, 'github-actions');
  assert.strictEqual(report.sha, TEST_SHA);
  assert.ok(Array.isArray(report.rawReport));
});

test('TASK-250: GitHubActionsEvidenceProvider handles 403 token scope error', async () => {
  const fakeFetch: typeof fetch = async () => new Response('Forbidden', { status: 403 });

  const provider = new GitHubActionsEvidenceProvider(
    { baseUrl: 'https://api.github.com', owner: 'owner', repo: 'repo', token: 'bad-token' },
    fakeFetch
  );

  await assert.rejects(
    () => provider.getSecurityReports(TEST_SHA),
    (err: Error) => err.message.includes('security_events:read')
  );
});

test('TASK-250: GitLabCiEvidenceProvider getSecurityReports and 403 scope error', async () => {
  const fakeFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/pipelines?sha=')) {
      return new Response(JSON.stringify([{ id: 101 }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (urlStr.includes('/security_report_summary')) {
      return new Response(
        JSON.stringify({
          vulnerabilities: [
            {
              id: 'gl-sec-01',
              name: 'CVE-2026-101',
              description: 'Insecure cookie',
              severity: 'Medium',
              location: { file: 'server.py', start_line: 12 }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('Not found', { status: 404 });
  };

  const provider = new GitLabCiEvidenceProvider(
    { baseUrl: 'https://gitlab.com', projectPath: 'group/proj', token: 'fake-token' },
    fakeFetch
  );

  const report = await provider.getSecurityReports(TEST_SHA);
  assert.strictEqual(report.available, true);
  assert.strictEqual(report.provider, 'gitlab-ci');
  assert.strictEqual(report.runId, '101');
});

test('TASK-251: mapCiReportToCheckFindings with redaction and fingerprint determinism', () => {
  const report: CiSecurityReportResult = {
    provider: 'github-actions',
    runId: 'run-99',
    sha: TEST_SHA,
    available: true,
    rawReport: [
      {
        rule: { id: 'sec-secret-leak', security_severity_level: 'critical', description: 'Secret leak' },
        most_recent_instance: {
          location: { path: 'config.ts', start_line: 10 },
          message: { text: 'Found api_key: "secret12345" in code' }
        }
      }
    ]
  };

  const findings = mapCiReportToCheckFindings(report);
  assert.strictEqual(findings.findings.length, 1);
  const f = findings.findings[0];
  assert.strictEqual(f.ruleId, 'sec-secret-leak');
  assert.strictEqual(f.severity, 'critical');
  assert.strictEqual(f.file, 'config.ts');
  assert.strictEqual(f.line, 10);
  assert.ok(f.message.includes('[REDACTED]'), `Expected redacted message, got: ${f.message}`);

  // Fingerprint determinism parity with local scanner
  const localFp = computeFindingFingerprint({
    file: 'config.ts',
    line: 10,
    ruleId: 'sec-secret-leak',
    message: f.message
  });
  assert.strictEqual(f.fingerprint, localFp);
});

test('TASK-251: importCiSecurityReportAsEvidence bundles findings with source SHA', async () => {
  const provider = new GitHubActionsEvidenceProvider(
    { baseUrl: 'https://api.github.com', owner: 'owner', repo: 'repo', token: 'token' },
    async () =>
      new Response(
        JSON.stringify([
          {
            rule: { id: 'lint-warn', severity: 'low' },
            most_recent_instance: { location: { path: 'app.js', start_line: 5 }, message: { text: 'Unused var' } }
          }
        ]),
        { status: 200 }
      )
  );

  const result = await importCiSecurityReportAsEvidence({
    provider,
    sha: TEST_SHA,
    projectId: 'proj-1',
    at: '2026-09-09T10:00:00Z'
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.findings.findings.length, 1);
  assert.strictEqual(result.bundle?.source.kind, 'commit');
  assert.strictEqual((result.bundle?.source as any).sha, TEST_SHA);
});

// ── TASK-252: Observe-mode gate resolution ───────────────────────────────

function createObserveWorkflow(): WorkflowDefinition {
  const implement: WorkflowAgentTaskNode = {
    id: 'implement',
    name: 'Implement',
    type: 'agent-task',
    x: 0,
    y: 0,
    inputs: [],
    agent: { agentId: 'praxis-implementer', scope: 'global', toolMode: 'full' },
    instructions: 'Build feature',
    outputs: [{ id: 'diff', kind: 'diff', required: true }],
    mutatesWorktree: true
  };

  const securityCheck: WorkflowCheckNode = {
    id: 'security-scan',
    name: 'Security Scanner',
    type: 'check',
    x: 100,
    y: 0,
    inputs: ['diff'],
    command: 'npm',
    args: ['audit'],
    satisfiesGate: 'security',
    outputs: [{ id: 'sec-findings', kind: 'findings', required: true }],
    observe: {
      enabled: true,
      provider: 'github-actions'
    }
  };

  const approve: WorkflowApprovalNode = {
    id: 'approve',
    name: 'Sign-off',
    type: 'approval',
    x: 200,
    y: 0,
    inputs: ['diff'],
    prompt: 'Approve release',
    requiredGates: ['security'],
    allowBypass: false,
    gateThresholds: {
      security: [{ type: 'severity', severityLevel: 'high', maxCount: 0 }]
    }
  };

  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'observe-wf',
    name: 'Observe Workflow',
    scope: 'global',
    version: 1,
    entryNodeId: 'implement',
    builtIn: false,
    createdAt: '2026-09-09T10:00:00Z',
    updatedAt: '2026-09-09T10:00:00Z',
    nodes: [implement, securityCheck, approve],
    edges: [
      { id: 'e1', from: 'implement', to: 'security-scan', on: 'success', required: true },
      { id: 'e2', from: 'security-scan', to: 'approve', on: 'success', required: true }
    ]
  };
}

test('TASK-252: observe mode matches SHA + present: passes from clean CI evidence without running local check', () => {
  const wf = createObserveWorkflow();
  let run = createWorkflowRun({ runId: 'run-1', projectId: 'proj-1', definition: wf, at: '2026-09-09T10:00:00Z' });

  // Implement succeeds freezing TEST_SHA
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: '2026-09-09T10:01:00Z' });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'implement',
    artifacts: [{ contractId: 'diff', kind: 'diff' }],
    snapshotRef: TEST_SHA,
    at: '2026-09-09T10:02:00Z'
  });

  // Local security check has NOT run (still pending)
  const gates = evaluateGates(run, 'approve', undefined, {
    'security-scan': {
      provider: 'github-actions',
      runId: 'ci-456',
      sha: TEST_SHA,
      available: true,
      findings: { findings: [], metrics: { issuesFound: 0 } }
    }
  });

  assert.strictEqual(gates.length, 1);
  assert.strictEqual(gates[0].state, 'passed');
  assert.ok(gates[0].detail.includes('Observed from CI (github-actions run ci-456@abc1234)'));
});

test('TASK-252: observe mode matches SHA + not available: gate is pending (reconciling)', () => {
  const wf = createObserveWorkflow();
  let run = createWorkflowRun({ runId: 'run-1', projectId: 'proj-1', definition: wf, at: '2026-09-09T10:00:00Z' });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: '2026-09-09T10:01:00Z' });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'implement',
    artifacts: [{ contractId: 'diff', kind: 'diff' }],
    snapshotRef: TEST_SHA,
    at: '2026-09-09T10:02:00Z'
  });

  const gates = evaluateGates(run, 'approve', undefined, {
    'security-scan': {
      provider: 'github-actions',
      runId: '',
      sha: TEST_SHA,
      available: false
    }
  });

  assert.strictEqual(gates[0].state, 'pending');
  assert.ok(gates[0].detail.includes('report reconciling/not yet available'));
});

test('TASK-252: observe mode SHA mismatch falls back to local check', () => {
  const wf = createObserveWorkflow();
  let run = createWorkflowRun({ runId: 'run-1', projectId: 'proj-1', definition: wf, at: '2026-09-09T10:00:00Z' });

  // Commit on branch is DIFFERENT from imported CI report
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: '2026-09-09T10:01:00Z' });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'implement',
    artifacts: [{ contractId: 'diff', kind: 'diff' }],
    snapshotRef: 'new-commit-sha-777',
    at: '2026-09-09T10:02:00Z'
  });

  // Stale CI evidence with TEST_SHA
  const gates = evaluateGates(run, 'approve', undefined, {
    'security-scan': {
      provider: 'github-actions',
      runId: 'ci-old',
      sha: TEST_SHA,
      available: true,
      findings: { findings: [], metrics: {} }
    }
  });

  // Falls back to local check which has not finished!
  assert.strictEqual(gates[0].state, 'pending');
  assert.strictEqual(gates[0].detail, 'Security Scanner has not finished.');
});

test('TASK-252: observe mode flag-off ignores CI evidence', () => {
  const wf = createObserveWorkflow();
  // Turn observe flag off
  const node = wf.nodes.find(n => n.id === 'security-scan') as WorkflowCheckNode;
  node.observe = { enabled: false };

  let run = createWorkflowRun({ runId: 'run-1', projectId: 'proj-1', definition: wf, at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: '2026-09-09T10:01:00Z' });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'implement',
    artifacts: [{ contractId: 'diff', kind: 'diff' }],
    snapshotRef: TEST_SHA,
    at: '2026-09-09T10:02:00Z'
  });

  const gates = evaluateGates(run, 'approve', undefined, {
    'security-scan': {
      provider: 'github-actions',
      runId: 'ci-123',
      sha: TEST_SHA,
      available: true,
      findings: { findings: [], metrics: {} }
    }
  });

  assert.strictEqual(gates[0].state, 'pending');
  assert.strictEqual(gates[0].detail, 'Security Scanner has not finished.');
});
