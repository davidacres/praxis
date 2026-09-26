/**
 * Iterative SDLC loop template (FX-BE-092 / TASK-253).
 *
 * The user-visible shape: plan → author BDD scenarios → implement → a wide
 * parallel verification band (lint, typecheck, unit tests, BDD run, SAST,
 * secrets, SCA, code review, test review, security review, advisory UX
 * review) → gate convergence → approval → optional deploy.
 *
 * Why the "iterate on failure" loop is not drawn as back-edges: the static
 * validator rejects every cycle (workflowValidation.findCycle), so a template
 * with a review → implement failure edge cannot be saved or instantiated. The
 * engine's loop instead is bounded iteration around each stage:
 * `maxAttempts` retries a stage that fails (check exit code, or an agent
 * stage that did not deliver its required findings artifact), and the
 * approval's `gateThresholds` hold the run at approval whenever any reviewer
 * or scanner reports a blocking finding, where the monitor's retry/rework
 * actions create the next revision. Provable, bounded, and valid.
 *
 * The four reviewer stages are deliberately separate agents over one diff:
 * code review and security review own their gates; test review reads the
 * implementation *and* the BDD scenarios and answers "are these tests real";
 * UX review is advisory (it satisfies no gate) so a subjective review cannot
 * block a delivery, while its findings still land on the run.
 */

import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from './workflowTypes';

export type SdlcLoopStackVariant = 'node' | 'dotnet' | 'python' | 'generic';

const NOW = '2026-09-10T00:00:00.000Z';

const REVIEW_FINDINGS_INSTRUCTIONS =
  'Review the implementation snapshot and return structured findings with file, line, severity, and a concrete suggestion for every finding. Prose alone fails this stage: the findings artifact is required.';

/** Check commands per stack, mirroring the full-sdlc variants. */
function stackCommands(variant: SdlcLoopStackVariant) {
  const isDotnet = variant === 'dotnet';
  const isPython = variant === 'python';
  const isGeneric = variant === 'generic';

  return {
    lint: isDotnet
      ? { command: 'dotnet', args: ['format', '--verify-no-changes'] }
      : isPython
      ? { command: 'ruff', args: ['check', '.'] }
      : isGeneric
      ? { command: 'echo', args: ['Configure lint command'] }
      : { command: 'npm', args: ['run', 'lint'] },
    typecheck: isDotnet
      ? { command: 'dotnet', args: ['build'] }
      : isPython
      ? { command: 'mypy', args: ['.'] }
      : isGeneric
      ? { command: 'echo', args: ['Configure typecheck command'] }
      : { command: 'npx', args: ['tsc', '--noEmit'] },
    unitTest: isDotnet
      ? { command: 'dotnet', args: ['test', '/p:CollectCoverage=true', '/p:CoverletOutputFormat=cobertura'] }
      : isPython
      ? { command: 'pytest', args: ['--cov=.', '--cov-report=xml:coverage.xml'] }
      : isGeneric
      ? { command: 'echo', args: ['Configure unit test command'] }
      : { command: 'npm', args: ['test'] },
    // BDD execution: the JUnit adapter parses the report into findings and
    // tests/passed/failed/passPct metrics, so the QA gate sees scenario
    // results through the same contract as unit tests.
    bddRun: isDotnet
      ? { command: 'echo', args: ['Configure BDD test command (Reqnroll/SpecFlow)'] }
      : isPython
      ? { command: 'behave', args: ['--junit', '--junit-directory', 'reports'] }
      : isGeneric
      ? { command: 'echo', args: ['Configure BDD test command'] }
      : { command: 'npx', args: ['cucumber-js', '--format', 'junit:reports/bdd-junit.xml'] },
    sast: { command: 'semgrep', args: ['scan', '--config=auto', '--sarif', '--output=semgrep.sarif'] },
    secrets: { command: 'gitleaks', args: ['detect', '--no-git', '--report-format=sarif', '--report-path=gitleaks.sarif'] },
    sca: isDotnet
      ? { command: 'dotnet', args: ['list', 'package', '--vulnerable'] }
      : isGeneric
      ? { command: 'echo', args: ['Configure SCA scan'] }
      : { command: 'osv-scanner', args: ['--format=sarif', '--output=osv.sarif', '.'] },
    deploy: isDotnet
      ? { command: 'dotnet', args: ['publish'] }
      : isPython
      ? { command: 'python', args: ['-m', 'deploy'] }
      : isGeneric
      ? { command: 'echo', args: ['Configure deployment command'] }
      : { command: 'npm', args: ['run', 'deploy'] }
  };
}

function reviewerAgentFor(variant: SdlcLoopStackVariant) {
  return variant === 'dotnet'
    ? { agentId: 'csharp-dotnet-code-reviewer', scope: 'global' as const, skillNames: ['dotnet-solid-dry'], toolMode: 'read-only' as const }
    : { agentId: 'praxis-reviewer', scope: 'global' as const, toolMode: 'read-only' as const };
}

/**
 * The iterative SDLC loop template.
 *
 * Gate ownership: `review` is owned by the code-review and test-review agents;
 * `security` by SAST, secrets, SCA, and the security analyst; `qa` by lint,
 * typecheck, unit tests, and the BDD run. UX review owns nothing on purpose.
 */
export function sdlcLoopTemplate(variant: SdlcLoopStackVariant = 'node'): WorkflowDefinition {
  const cmd = stackCommands(variant);
  const id = variant === 'node' ? 'full-sdlc-loop' : `full-sdlc-loop-${variant}`;
  const title =
    variant === 'node'
      ? 'Full SDLC Loop'
      : variant === 'dotnet'
      ? 'Full SDLC Loop (.NET)'
      : variant === 'python'
      ? 'Full SDLC Loop (Python)'
      : 'Full SDLC Loop (generic)';

  const reviewer = reviewerAgentFor(variant);

  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    name: title,
    description:
      'Iterative SDLC: BDD scenarios authored before code, parallel QA/security/review verification with structured findings, and bounded retry plus gate-held approval so every failed stage loops until clean.',
    scope: 'global',
    version: 1,
    trigger: 'ticket',
    entryNodeId: 'plan',
    builtIn: false,
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [
      {
        type: 'agent-task',
        id: 'plan',
        name: 'Plan',
        x: 0,
        y: 160,
        inputs: [],
        agent: { agentId: 'praxis-planner', profileId: 'praxis-planner', hostId: 'praxis-planner', scope: 'global', toolMode: 'read-only' },
        instructions:
          'Analyze the task, verify the existing architecture, and produce a structured implementation plan covering behaviour, risk, and the acceptance scenarios the BDD stage should encode.',
        outputs: [{ id: 'plan-doc', kind: 'plan', required: true }],
        mutatesWorktree: false,
        maxAttempts: 2
      },
      {
        type: 'agent-task',
        id: 'bdd-author',
        name: 'Author BDD scenarios',
        x: 180,
        y: 40,
        inputs: ['plan-doc'],
        agent: { agentId: 'praxis-test-author', profileId: 'praxis-test-author', hostId: 'praxis-test-author', scope: 'global', toolMode: 'full', skillNames: ['praxis-test-contracts'] },
        instructions:
          'Turn the plan into executable acceptance coverage: write the project\'s BDD scenarios where that convention exists and author/update the structured English Praxis Test catalog with one contract per acceptance rule. Do not implement step definitions or product code.',
        outputs: [{ id: 'bdd-scenarios', kind: 'report', required: true, description: 'The authored .feature scenarios.' }],
        mutatesWorktree: true,
        maxAttempts: 2
      },
      {
        type: 'agent-task',
        id: 'implement',
        name: 'Implement',
        x: 380,
        y: 160,
        inputs: ['plan-doc', 'bdd-scenarios'],
        agent: { agentId: 'praxis-implementer', profileId: 'praxis-implementer', hostId: 'praxis-implementer', scope: 'global', toolMode: 'full', skillNames: ['verification-report', 'visual-verification'] },
        instructions:
          'Implement the plan, wiring the BDD scenarios to real behaviour and making them pass. Run automated tests to verify your changes and fix any broken or outdated tests before committing clean changes and reporting the ref.',
        outputs: [{ id: 'change-diff', kind: 'diff', required: true }],
        mutatesWorktree: true,
        maxAttempts: 3
      },
      // ── QA gate band ────────────────────────────────────────────────
      {
        type: 'check',
        id: 'lint',
        name: 'Lint',
        x: 600,
        y: 0,
        inputs: ['change-diff'],
        ...cmd.lint,
        successExitCodes: [0],
        outputs: [{ id: 'lint-findings', kind: 'findings', required: true }],
        satisfiesGate: 'qa',
        maxAttempts: 2
      },
      {
        type: 'check',
        id: 'typecheck',
        name: 'Type check',
        x: 600,
        y: 40,
        inputs: ['change-diff'],
        ...cmd.typecheck,
        successExitCodes: [0],
        outputs: [{ id: 'typecheck-findings', kind: 'findings', required: true }],
        satisfiesGate: 'qa',
        maxAttempts: 2
      },
      {
        type: 'check',
        id: 'unit-test',
        name: 'Unit tests & coverage',
        x: 600,
        y: 80,
        inputs: ['change-diff'],
        ...cmd.unitTest,
        successExitCodes: [0],
        outputs: [{ id: 'test-findings', kind: 'findings', required: true, adapter: 'cobertura' }],
        reportPath: variant === 'dotnet' ? 'coverage.cobertura.xml' : variant === 'python' ? 'coverage.xml' : 'coverage/cobertura-coverage.xml',
        adapter: 'cobertura',
        satisfiesGate: 'qa',
        maxAttempts: 2
      },
      {
        type: 'check',
        id: 'bdd-run',
        name: 'BDD scenarios run',
        x: 600,
        y: 120,
        inputs: ['bdd-scenarios', 'change-diff'],
        ...cmd.bddRun,
        successExitCodes: [0],
        outputs: [{ id: 'bdd-findings', kind: 'findings', required: true, adapter: 'junit' }],
        reportPath: variant === 'python' ? 'reports' : 'reports/bdd-junit.xml',
        adapter: 'junit',
        satisfiesGate: 'qa',
        maxAttempts: 2
      },
      // ── Security gate band ──────────────────────────────────────────
      {
        type: 'check',
        id: 'sast',
        name: 'SAST scan',
        x: 600,
        y: 160,
        inputs: ['change-diff'],
        ...cmd.sast,
        successExitCodes: [0],
        outputs: [{ id: 'sast-findings', kind: 'findings', required: true, adapter: 'sarif' }],
        reportPath: 'semgrep.sarif',
        adapter: 'sarif',
        satisfiesGate: 'security',
        maxAttempts: 2
      },
      {
        type: 'check',
        id: 'secrets',
        name: 'Secret scan',
        x: 600,
        y: 200,
        inputs: ['change-diff'],
        ...cmd.secrets,
        successExitCodes: [0],
        outputs: [{ id: 'secret-findings', kind: 'findings', required: true, adapter: 'sarif' }],
        reportPath: 'gitleaks.sarif',
        adapter: 'sarif',
        satisfiesGate: 'security',
        maxAttempts: 2
      },
      {
        type: 'check',
        id: 'sca',
        name: 'SCA scan',
        x: 600,
        y: 240,
        inputs: ['change-diff'],
        ...cmd.sca,
        successExitCodes: [0],
        outputs: [{ id: 'sca-findings', kind: 'findings', required: true, adapter: 'sarif' }],
        reportPath: 'osv.sarif',
        adapter: 'sarif',
        satisfiesGate: 'security',
        maxAttempts: 2
      },
      // ── Review gate band ────────────────────────────────────────────
      {
        type: 'agent-task',
        id: 'review',
        name: 'Code review',
        x: 600,
        y: 280,
        inputs: ['change-diff'],
        agent: { ...reviewer, skillNames: [...(reviewer.skillNames ?? []), 'praxis-test-contracts'] },
        instructions: REVIEW_FINDINGS_INSTRUCTIONS,
        outputs: [{ id: 'review-findings', kind: 'findings', required: true }],
        mutatesWorktree: false,
        satisfiesGate: 'review',
        maxAttempts: 3
      },
      {
        type: 'agent-task',
        id: 'test-review',
        name: 'Automated test review',
        x: 600,
        y: 320,
        inputs: ['bdd-scenarios', 'change-diff'],
        agent: reviewer,
        instructions:
          'Review the automated tests and the authored BDD scenarios against the implementation: do the scenarios match the plan, do the step definitions test real behaviour, and are the unit tests meaningful rather than tautological? ' +
          REVIEW_FINDINGS_INSTRUCTIONS,
        outputs: [{ id: 'test-review-findings', kind: 'findings', required: true }],
        mutatesWorktree: false,
        satisfiesGate: 'review',
        maxAttempts: 3
      },
      {
        type: 'agent-task',
        id: 'security-review',
        name: 'Security review',
        x: 600,
        y: 360,
        inputs: ['change-diff'],
        agent: { agentId: 'praxis-security-analyst', profileId: 'praxis-security-analyst', hostId: 'praxis-security-analyst', scope: 'global', toolMode: 'read-only', skillNames: ['electron-hardening', 'ci-workflow-hardening'] },
        instructions:
          'Review the change for security issues the scanners cannot see: authorization gaps, injection via new inputs, unsafe deserialization, and business-logic abuse. ' +
          REVIEW_FINDINGS_INSTRUCTIONS,
        outputs: [{ id: 'security-review-findings', kind: 'findings', required: true }],
        mutatesWorktree: false,
        satisfiesGate: 'security',
        maxAttempts: 3
      },
      // ── Advisory band ───────────────────────────────────────────────
      {
        type: 'agent-task',
        id: 'ux-review',
        name: 'UI/UX review (advisory)',
        x: 600,
        y: 400,
        inputs: ['change-diff'],
        agent: reviewer,
        instructions:
          'Review the change for UI/UX impact from the diff alone: copy quality, interaction states (loading, empty, error), accessibility (labels, focus, contrast risks), and consistency with existing patterns. Advisory: your findings are reported but cannot block delivery.',
        outputs: [{ id: 'ux-review-findings', kind: 'findings', required: true }],
        mutatesWorktree: false,
        maxAttempts: 2
      },
      // ── Convergence ───────────────────────────────────────────────���─
      { type: 'join', id: 'gates', name: 'SDLC gates', x: 860, y: 200, inputs: [], mode: 'all' },
      {
        type: 'approval',
        id: 'approve',
        name: 'Approve',
        x: 1080,
        y: 200,
        inputs: ['review-findings', 'test-review-findings', 'security-review-findings'],
        prompt:
          'QA (lint, types, unit tests, BDD scenarios), security (SAST, secrets, SCA, analyst review), and code review have converged. Any high-or-worse review or security finding, or coverage below 80%, is still holding the run — resolve and rework before approving.',
        requiredGates: ['qa', 'security', 'review'],
        allowBypass: false,
        gateThresholds: {
          qa: [{ type: 'metric', metric: 'lineCoveragePct', operator: '>=', value: 80 }],
          security: [{ type: 'severity', severityLevel: 'high', maxCount: 0 }],
          review: [{ type: 'severity', severityLevel: 'high', maxCount: 0 }]
        }
      },
      {
        type: 'check',
        id: 'deploy',
        name: 'Deploy',
        x: 1300,
        y: 200,
        inputs: ['change-diff'],
        ...cmd.deploy,
        successExitCodes: [0],
        outputs: []
      }
    ],
    edges: [
      { id: 'e-plan-bdd', from: 'plan', to: 'bdd-author', on: 'success', required: true },
      { id: 'e-bdd-impl', from: 'bdd-author', to: 'implement', on: 'success', required: true },
      { id: 'e-impl-lint', from: 'implement', to: 'lint', on: 'success', required: false },
      { id: 'e-impl-typecheck', from: 'implement', to: 'typecheck', on: 'success', required: false },
      { id: 'e-impl-test', from: 'implement', to: 'unit-test', on: 'success', required: true },
      { id: 'e-impl-bdd', from: 'implement', to: 'bdd-run', on: 'success', required: true },
      { id: 'e-impl-sast', from: 'implement', to: 'sast', on: 'success', required: true },
      { id: 'e-impl-secrets', from: 'implement', to: 'secrets', on: 'success', required: true },
      { id: 'e-impl-sca', from: 'implement', to: 'sca', on: 'success', required: true },
      { id: 'e-impl-review', from: 'implement', to: 'review', on: 'success', required: true },
      { id: 'e-impl-testreview', from: 'implement', to: 'test-review', on: 'success', required: true },
      { id: 'e-impl-secreview', from: 'implement', to: 'security-review', on: 'success', required: true },
      { id: 'e-impl-ux', from: 'implement', to: 'ux-review', on: 'success', required: false },
      { id: 'e-lint-gates', from: 'lint', to: 'gates', on: 'success', required: false },
      { id: 'e-typecheck-gates', from: 'typecheck', to: 'gates', on: 'success', required: false },
      { id: 'e-test-gates', from: 'unit-test', to: 'gates', on: 'success', required: true },
      { id: 'e-bdd-gates', from: 'bdd-run', to: 'gates', on: 'success', required: true },
      { id: 'e-sast-gates', from: 'sast', to: 'gates', on: 'success', required: true },
      { id: 'e-secrets-gates', from: 'secrets', to: 'gates', on: 'success', required: true },
      { id: 'e-sca-gates', from: 'sca', to: 'gates', on: 'success', required: true },
      { id: 'e-review-gates', from: 'review', to: 'gates', on: 'success', required: true },
      { id: 'e-testreview-gates', from: 'test-review', to: 'gates', on: 'success', required: true },
      { id: 'e-secreview-gates', from: 'security-review', to: 'gates', on: 'success', required: true },
      { id: 'e-ux-gates', from: 'ux-review', to: 'gates', on: 'success', required: false },
      { id: 'e-gates-approve', from: 'gates', to: 'approve', on: 'success', required: true },
      { id: 'e-approve-deploy', from: 'approve', to: 'deploy', on: 'success', required: false }
    ]
  };
}

export function sdlcLoopMarketplaceTemplates(): WorkflowDefinition[] {
  return [
    sdlcLoopTemplate('node'),
    sdlcLoopTemplate('dotnet'),
    sdlcLoopTemplate('python'),
    sdlcLoopTemplate('generic')
  ];
}
