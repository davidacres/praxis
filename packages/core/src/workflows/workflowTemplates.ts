/**
 * Workflow template library (FX-BE-021 / TASK-101).
 *
 * A template is just a `WorkflowDefinition` a user starts from. The library
 * offers three tiers — the app's built-ins, the user's saved globals, and a
 * project's committed definitions — and turning one into a project's own
 * workflow is a copy of the *definition*, never of an agent manifest. The copy
 * keeps the agent ids; whether those ids resolve is answered separately, before
 * the workflow can run.
 *
 * The built-in `governed-delivery` template is defined here rather than in
 * FX-BE-022 because the designer needs something to open on day one. FX-BE-022
 * registers it as the delivery default and adds the run-monitor around it.
 */

import { WORKFLOW_SCHEMA_VERSION, isAgentTaskNode, type WorkflowCheckNode, type WorkflowDefinition } from './workflowTypes';
import type { AgentWorkflowReference } from '../ai/agentTypes';
import { validateWorkflow } from './workflowValidation';
import type { AgentCatalogSnapshot } from './workflowPreflight';
import { preflightWorkflow } from './workflowPreflight';
import type { WorkflowSource } from './workflowStore';
import {
  AVAILABLE_AGENT_DEFINITIONS,
  AVAILABLE_SKILL_DEFINITIONS
} from '../ai/agentRuntime/bundledAgents';
import { sdlcLoopMarketplaceTemplates } from './sdlcLoopTemplates';
import { defaultTierForStage } from './stageModel';

export interface WorkflowTemplate {
  definition: WorkflowDefinition;
  source: WorkflowSource;
  /** Absolute path, for project-sourced templates. */
  path?: string;
  /** True for the app's own templates, which cannot be edited in place. */
  builtIn: boolean;
}

export interface WorkflowAgentDependency {
  /** Legacy runtime-host alias retained for existing installers. */
  agentId: string;
  profileId: string;
  hostId: string;
  providerId?: string;
  scope: 'global' | 'project';
  skillNames: string[];
  nodeIds: string[];
  status: 'installed' | 'available' | 'missing';
  reason?: string;
}

/** Per-template readiness, so a bad Agent Hub reference is visible before a run. */
export interface TemplateReadiness {
  templateId: string;
  /** Structurally valid — cycles, dangling refs, gates all check out. */
  structureOk: boolean;
  /** Every agent stage resolves against the live catalog. */
  agentsOk: boolean;
  /** Node id → the first blocking reason, for the ones that failed. */
  blockingByNode: Record<string, string>;
  /** All agent dependencies identified from the workflow's nodes. */
  dependencies: WorkflowAgentDependency[];
  /** True if all dependencies are either already installed or available to install automatically. */
  autoInstallable: boolean;
}

// ── Built-in templates ───────────────────────────────────────────────────

const NOW = '2026-09-02T00:00:00.000Z';

/**
 * The stage that gives a run's worktree its dependencies.
 *
 * A run works in a fresh git worktree, and `node_modules` is gitignored, so it starts with none. Tools
 * only "work" there when something up the directory tree happens to supply them — which is how a
 * monorepo's tests pass right up until a workspace package with its own nested dependencies
 * (`packages/x/node_modules`) fails to compile with a missing module. Installing, rather than linking
 * the main checkout's `node_modules`, keeps the run isolated: a linked directory is shared mutable
 * state (an agent's `npm install` would write into the user's real checkout) and goes stale when a
 * stage changes the lockfile.
 *
 * `--registry` names the public registry on purpose. With a private default registry (GitHub Packages,
 * most internal feeds) npm rewrites the lockfile's `registry.npmjs.org` tarball URLs to that registry
 * and every public package 404s on a cold cache. Scoped registries (`@scope:registry=`) are unaffected.
 */
function installDependenciesNode(x: number, y: number): WorkflowCheckNode {
  return {
    type: 'check',
    id: 'install',
    name: 'Install dependencies',
    x,
    y,
    inputs: ['change-diff'],
    command: 'npm',
    args: ['ci', '--registry=https://registry.npmjs.org/'],
    successExitCodes: [0],
    // Long on purpose: a cold install of a large workspace is minutes, not seconds.
    timeoutMs: 600000,
    maxAttempts: 2,
    outputs: [{ id: 'install-log', kind: 'log', required: true }]
  };
}

/**
 * The stage that produces the build outputs the tests load.
 *
 * Build output (`dist/`, `out/`, a copied renderer …) is gitignored, so — like `node_modules` — a run
 * worktree has none. Anything that runs the built product against it fails in a way that looks
 * nothing like "you forgot to build": a desktop app's end-to-end suite opens a window that is simply
 * blank because the page it loads was never produced. `--if-present` makes this a no-op for a project
 * with no `build` script, and its log is optional because that no-op prints nothing (a required log
 * with no output would fail the stage for having nothing to say).
 */
function buildNode(x: number, y: number): WorkflowCheckNode {
  return {
    type: 'check',
    id: 'build',
    name: 'Build',
    x,
    y,
    inputs: ['change-diff'],
    command: 'npm',
    args: ['run', 'build', '--if-present'],
    successExitCodes: [0],
    timeoutMs: 900000,
    outputs: [{ id: 'build-log', kind: 'log', required: false }]
  };
}

/**
 * Plan → Implement → Praxis Tests → (Review ∥ Security ∥ Install → Build → QA) → Gates → Approve.
 *
 * The agent ids (`praxis-planner`, `praxis-implementer`, `praxis-reviewer`) are
 * conventional: a project points them at real Agent Hub agents, or the designer
 * flags them as unresolved. QA and security are deterministic checks precisely
 * so their gates cannot be waved through by an agent.
 */
export function governedDeliveryTemplate(): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'governed-delivery',
    name: 'Governed delivery',
    description: 'Plan, implement, then converge review, QA, and security before a human approves.',
    scope: 'global',
    version: 1,
    entryNodeId: 'plan',
    builtIn: true,
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
        instructions: 'Produce an implementation plan for the assigned task.',
        outputs: [{ id: 'plan-doc', kind: 'plan', required: true, description: 'The implementation plan.' }],
        mutatesWorktree: false
      },
      {
        type: 'agent-task',
        id: 'implement',
        name: 'Implement',
        x: 240,
        y: 160,
        inputs: ['plan-doc'],
        agent: { agentId: 'praxis-implementer', profileId: 'praxis-implementer', hostId: 'praxis-implementer', scope: 'global', toolMode: 'full', skillNames: ['verification-report', 'visual-verification'] },
        instructions: 'Implement the plan. Run automated tests to verify your changes, fix any broken or outdated tests, commit the clean change, and report the ref.',
        outputs: [{ id: 'change-diff', kind: 'diff', required: true, description: 'The implemented change.' }],
        mutatesWorktree: true,
        maxAttempts: 2
      },
      {
        type: 'agent-task',
        id: 'test-contracts',
        name: 'Praxis Test contracts',
        x: 360,
        y: 160,
        inputs: ['change-diff'],
        agent: { agentId: 'praxis-test-author', profileId: 'praxis-test-author', hostId: 'praxis-test-author', scope: 'global', toolMode: 'full', skillNames: ['praxis-test-contracts'] },
        instructions: 'Inventory the automated QA tests, author or update the structured English Praxis Test catalog, and run its deterministic validator. Ensure automated tests pass and report the exact test count, coverage links, and any stale or ambiguous contracts.',
        outputs: [{ id: 'test-contracts', kind: 'report', required: true, description: 'The validated Praxis Test catalog and coverage report.' }],
        mutatesWorktree: true,
        maxAttempts: 2
      },
      {
        type: 'agent-task',
        id: 'review',
        name: 'Review',
        x: 600,
        y: 0,
        inputs: ['change-diff', 'test-contracts'],
        agent: { agentId: 'praxis-reviewer', profileId: 'praxis-reviewer', hostId: 'praxis-reviewer', scope: 'global', toolMode: 'read-only' },
        instructions: 'Review the implementation snapshot for correctness and quality using the change-diff input artifact and read-only file access. Do not run shell commands.',
        outputs: [{ id: 'review-report', kind: 'report', required: true }],
        mutatesWorktree: false,
        satisfiesGate: 'review'
      },
      installDependenciesNode(600, 240),
      buildNode(840, 240),
      {
        type: 'agent-task',
        id: 'qa-repair-agent',
        name: 'Repair QA failures',
        x: 1080,
        y: 400,
        inputs: ['change-diff', 'qa-results'],
        agent: { agentId: 'praxis-implementer', profileId: 'praxis-implementer', hostId: 'praxis-implementer', scope: 'global', toolMode: 'full', skillNames: ['verification-report'] },
        instructions: 'Inspect the failed QA evidence, diagnose the smallest safe fix, implement it in the worktree, and commit the repair. Do not weaken, remove, or bypass tests.',
        outputs: [{ id: 'qa-repair-diff', kind: 'diff', required: true }],
        mutatesWorktree: true,
        maxAttempts: 1
      },
      {
        type: 'check',
        id: 'qa',
        name: 'QA',
        x: 1080,
        y: 240,
        inputs: ['change-diff', 'test-contracts', 'install-log'],
        command: 'npm',
        args: ['test'],
        successExitCodes: [0],
        outputs: [{ id: 'qa-results', kind: 'test-results', required: true }],
        satisfiesGate: 'qa',
        // Keep a failed QA run open so the user can retry QA without rerunning implementation.
        maxAttempts: 2,
        failureRecovery: { repairNodeId: 'qa-repair-agent', maxAttempts: 2 }
      },
      {
        type: 'check',
        id: 'security',
        name: 'Security scan',
        x: 600,
        y: 400,
        inputs: ['change-diff'],
        command: 'npm',
        // Audited against the public registry on purpose. `npm audit` asks the *configured* registry
        // for advisories, and many (GitHub Packages, most private feeds) have no audit endpoint: the
        // command then exits 1 without having looked at anything and, as a required gate, would end
        // the run. The public advisory database is the source of truth; private package names simply
        // have no advisories there.
        args: ['audit', '--audit-level=high', '--registry=https://registry.npmjs.org/'],
        successExitCodes: [0],
        outputs: [{ id: 'security-report', kind: 'report', required: true }],
        satisfiesGate: 'security'
      },
      { type: 'join', id: 'gates', name: 'Gates', x: 1200, y: 160, inputs: [], mode: 'all' },
      {
        type: 'approval',
        id: 'approve',
        name: 'Approve',
        x: 1440,
        y: 160,
        inputs: ['review-report', 'test-contracts', 'qa-results', 'security-report'],
        prompt: 'Review, QA, and security have passed. Approve this change for delivery?',
        requiredGates: ['review', 'qa', 'security'],
        allowBypass: false
      }
    ],
    edges: [
      { id: 'e-plan-impl', from: 'plan', to: 'implement', on: 'success', required: true },
      { id: 'e-impl-tests', from: 'implement', to: 'test-contracts', on: 'success', required: true },
      { id: 'e-tests-review', from: 'test-contracts', to: 'review', on: 'success', required: true },
      { id: 'e-tests-install', from: 'test-contracts', to: 'install', on: 'success', required: true },
      { id: 'e-install-build', from: 'install', to: 'build', on: 'success', required: true },
      { id: 'e-build-qa', from: 'build', to: 'qa', on: 'success', required: true },
      { id: 'e-qa-repair', from: 'qa', to: 'qa-repair-agent', on: 'failure', required: false },
      { id: 'e-tests-sec', from: 'test-contracts', to: 'security', on: 'success', required: true },
      { id: 'e-review-gates', from: 'review', to: 'gates', on: 'success', required: true },
      { id: 'e-qa-gates', from: 'qa', to: 'gates', on: 'success', required: true },
      { id: 'e-sec-gates', from: 'security', to: 'gates', on: 'success', required: true },
      { id: 'e-gates-approve', from: 'gates', to: 'approve', on: 'success', required: true }
    ]
  };
}

/** A minimal starting point: implement then approve, no gates. */
export function quickChangeTemplate(): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'quick-change',
    name: 'Quick change',
    description: 'One implementation stage and a human sign-off. No automated gates.',
    scope: 'global',
    version: 1,
    entryNodeId: 'implement',
    builtIn: true,
    createdAt: NOW,
    updatedAt: NOW,
    nodes: [
      {
        type: 'agent-task',
        id: 'implement',
        name: 'Implement',
        x: 0,
        y: 0,
        inputs: [],
        agent: { agentId: 'praxis-implementer', profileId: 'praxis-implementer', hostId: 'praxis-implementer', scope: 'global', toolMode: 'full', skillNames: ['verification-report', 'visual-verification'] },
        instructions: 'Implement the assigned change.',
        outputs: [{ id: 'change-diff', kind: 'diff', required: true }],
        mutatesWorktree: true
      },
      {
        type: 'approval',
        id: 'approve',
        name: 'Approve',
        x: 240,
        y: 0,
        inputs: ['change-diff'],
        prompt: 'Approve this change?',
        requiredGates: [],
        allowBypass: false
      }
    ],
    edges: [{ id: 'e-impl-approve', from: 'implement', to: 'approve', on: 'success', required: true }]
  };
}

export type FullSdlcStackVariant = 'node' | 'dotnet' | 'python' | 'generic';

/**
 * Full SDLC quality and security gates template (FX-BE-090 / TASK-248 / TASK-249).
 * Plan → Implement → (Lint ∥ Typecheck ∥ Test ∥ SAST ∥ Secrets ∥ SCA ∥ Review) → Gates → Approve → Deploy (optional).
 */
export function fullSdlcTemplate(variant: FullSdlcStackVariant = 'node'): WorkflowDefinition {
  const isDotnet = variant === 'dotnet';
  const isPython = variant === 'python';
  const isGeneric = variant === 'generic';
  // Lint, type check and unit tests run the project's own toolchain, which needs its dependencies. The
  // scanners (SAST, secrets, SCA) and the reviewer read the tree and do not, so they do not wait.
  const needsInstall = variant === 'node';

  const id = variant === 'node' ? 'full-sdlc' : `full-sdlc-${variant}`;
  const title =
    variant === 'node'
      ? 'Full SDLC'
      : variant === 'dotnet'
      ? 'Full SDLC (.NET)'
      : variant === 'python'
      ? 'Full SDLC (Python)'
      : 'Full SDLC (generic)';

  const description =
    'Complete SDLC automation with parallel lint, typecheck, test coverage, SAST, secrets, SCA, and code review gates.';

  // Check commands per stack
  const lintCmd = isDotnet
    ? { command: 'dotnet', args: ['format', '--verify-no-changes'] }
    : isPython
    ? { command: 'ruff', args: ['check', '.'] }
    : isGeneric
    ? { command: 'echo', args: ['Configure lint command'] }
    : { command: 'npm', args: ['run', 'lint'] };

  const typecheckCmd = isDotnet
    ? { command: 'dotnet', args: ['build'] }
    : isPython
    ? { command: 'mypy', args: ['.'] }
    : isGeneric
    ? { command: 'echo', args: ['Configure typecheck command'] }
    : { command: 'npx', args: ['tsc', '--noEmit'] };

  const testCmd = isDotnet
    ? { command: 'dotnet', args: ['test', '/p:CollectCoverage=true', '/p:CoverletOutputFormat=cobertura'] }
    : isPython
    ? { command: 'pytest', args: ['--cov=.'] }
    : isGeneric
    ? { command: 'echo', args: ['Configure test command'] }
    : { command: 'npm', args: ['test'] };

  const scaCmd = isDotnet
    ? { command: 'dotnet', args: ['list', 'package', '--vulnerable'] }
    : isGeneric
    ? { command: 'echo', args: ['Configure SCA scan'] }
    : { command: 'osv-scanner', args: ['--format=sarif', '--output=osv.sarif', '.'] };

  const deployCmd = isDotnet
    ? { command: 'dotnet', args: ['publish'] }
    : isPython
    ? { command: 'python', args: ['-m', 'deploy'] }
    : isGeneric
    ? { command: 'echo', args: ['Configure deployment command'] }
    : { command: 'npm', args: ['run', 'deploy'] };

  const reviewerAgent = isDotnet
    ? { agentId: 'csharp-dotnet-code-reviewer', scope: 'global' as const, skillNames: ['dotnet-solid-dry'], toolMode: 'read-only' as const }
    : { agentId: 'praxis-reviewer', scope: 'global' as const, toolMode: 'read-only' as const };

  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    name: title,
    description,
    trigger: 'ticket',
    scope: 'global',
    version: 1,
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
        instructions: 'Analyze requirements, verify existing architecture, and produce structured plan.',
        outputs: [{ id: 'plan-doc', kind: 'plan', required: true }],
        mutatesWorktree: false
      },
      {
        type: 'agent-task',
        id: 'implement',
        name: 'Implement',
        x: 200,
        y: 160,
        inputs: ['plan-doc'],
        agent: { agentId: 'praxis-implementer', profileId: 'praxis-implementer', hostId: 'praxis-implementer', scope: 'global', toolMode: 'full', skillNames: ['verification-report', 'visual-verification'] },
        instructions: 'Implement changes matching plan specifications, verify changes by running automated tests and fixing any broken or outdated tests, and commit clean changes to the branch.',
        outputs: [{ id: 'change-diff', kind: 'diff', required: true }],
        mutatesWorktree: true,
        maxAttempts: 3
      },
      ...(needsInstall ? [installDependenciesNode(320, 60), buildNode(440, 130)] : []),
      // QA gate checks
      {
        type: 'check',
        id: 'lint',
        name: 'Lint',
        x: 440,
        y: 0,
        inputs: ['change-diff'],
        ...lintCmd,
        successExitCodes: [0],
        outputs: [{ id: 'lint-findings', kind: 'findings', required: true }],
        satisfiesGate: 'qa'
      },
      {
        type: 'check',
        id: 'typecheck',
        name: 'Type check',
        x: 440,
        y: 60,
        inputs: ['change-diff'],
        ...typecheckCmd,
        successExitCodes: [0],
        outputs: [{ id: 'typecheck-findings', kind: 'findings', required: true }],
        satisfiesGate: 'qa'
      },
      {
        type: 'check',
        id: 'test',
        name: 'Unit tests & coverage',
        x: needsInstall ? 560 : 440,
        y: 120,
        inputs: ['change-diff'],
        ...testCmd,
        successExitCodes: [0],
        outputs: [{ id: 'test-findings', kind: 'findings', required: true }],
        satisfiesGate: 'qa'
      },
      // Security gate checks
      {
        type: 'check',
        id: 'sast',
        name: 'SAST scan',
        x: 440,
        y: 200,
        inputs: ['change-diff'],
        command: 'semgrep',
        args: ['scan', '--config=auto', '--sarif', '--output=semgrep.sarif'],
        successExitCodes: [0],
        outputs: [{ id: 'sast-findings', kind: 'findings', required: true }],
        satisfiesGate: 'security'
      },
      {
        type: 'check',
        id: 'secrets',
        name: 'Secret scan',
        x: 440,
        y: 260,
        inputs: ['change-diff'],
        command: 'gitleaks',
        args: ['detect', '--no-git', '--report-format=sarif', '--report-path=gitleaks.sarif'],
        successExitCodes: [0],
        outputs: [{ id: 'secret-findings', kind: 'findings', required: true }],
        satisfiesGate: 'security'
      },
      {
        type: 'check',
        id: 'sca',
        name: 'SCA scan',
        x: 440,
        y: 320,
        inputs: ['change-diff'],
        ...scaCmd,
        successExitCodes: [0],
        outputs: [{ id: 'sca-findings', kind: 'findings', required: true }],
        satisfiesGate: 'security'
      },
      // Review gate
      {
        type: 'agent-task',
        id: 'review',
        name: 'Structured code review',
        x: 440,
        y: 400,
        inputs: ['change-diff'],
        agent: reviewerAgent,
        instructions: 'Review changes against quality and security criteria and return structured findings.',
        outputs: [{ id: 'review-findings', kind: 'findings', required: true }],
        mutatesWorktree: false,
        satisfiesGate: 'review',
        maxAttempts: 3
      },
      // Convergence Join
      {
        type: 'join',
        id: 'gates',
        name: 'SDLC Gates',
        x: 680,
        y: 160,
        inputs: [],
        mode: 'all'
      },
      // Approval
      {
        type: 'approval',
        id: 'approve',
        name: 'Approve',
        x: 900,
        y: 160,
        inputs: ['change-diff', 'review-findings'],
        prompt: 'All QA, Security, and Code Review quality gates have passed. Sign off on changes?',
        requiredGates: ['qa', 'security', 'review'],
        allowBypass: false,
        gateThresholds: {
          qa: [{ type: 'metric', metric: 'coverage', operator: '>=', value: 80 }],
          security: [{ type: 'severity', severityLevel: 'high', maxCount: 0 }],
          review: [{ type: 'severity', severityLevel: 'high', maxCount: 0 }]
        }
      },
      // Optional trailing deploy node
      {
        type: 'check',
        id: 'deploy',
        name: 'Deploy',
        x: 1100,
        y: 160,
        inputs: ['change-diff'],
        ...deployCmd,
        successExitCodes: [0],
        outputs: []
      }
    ],
    edges: [
      { id: 'e-plan-impl', from: 'plan', to: 'implement', on: 'success', required: true },
      // The QA toolchain waits for the install; everything else starts from the implementation directly.
      ...(needsInstall ? [{ id: 'e-impl-install', from: 'implement', to: 'install', on: 'success' as const, required: true }] : []),
      { id: 'e-impl-lint', from: needsInstall ? 'install' : 'implement', to: 'lint', on: 'success', required: false },
      { id: 'e-impl-typecheck', from: needsInstall ? 'install' : 'implement', to: 'typecheck', on: 'success', required: false },
      // Unit tests run the built product, so they wait for the build; lint and type check do not.
      ...(needsInstall ? [{ id: 'e-install-build', from: 'install', to: 'build', on: 'success' as const, required: true }] : []),
      { id: 'e-impl-test', from: needsInstall ? 'build' : 'implement', to: 'test', on: 'success', required: true },
      { id: 'e-impl-sast', from: 'implement', to: 'sast', on: 'success', required: true },
      { id: 'e-impl-sec', from: 'implement', to: 'secrets', on: 'success', required: true },
      { id: 'e-impl-sca', from: 'implement', to: 'sca', on: 'success', required: true },
      { id: 'e-impl-rev', from: 'implement', to: 'review', on: 'success', required: true },
      { id: 'e-lint-gates', from: 'lint', to: 'gates', on: 'success', required: false },
      { id: 'e-typecheck-gates', from: 'typecheck', to: 'gates', on: 'success', required: false },
      { id: 'e-test-gates', from: 'test', to: 'gates', on: 'success', required: true },
      { id: 'e-sast-gates', from: 'sast', to: 'gates', on: 'success', required: true },
      { id: 'e-sec-gates', from: 'secrets', to: 'gates', on: 'success', required: true },
      { id: 'e-sca-gates', from: 'sca', to: 'gates', on: 'success', required: true },
      { id: 'e-rev-gates', from: 'review', to: 'gates', on: 'success', required: true },
      { id: 'e-gates-approve', from: 'gates', to: 'approve', on: 'success', required: true },
      { id: 'e-approve-deploy', from: 'approve', to: 'deploy', on: 'success', required: false }
    ]
  };
}

export function detectStackFromLanguages(languages?: string[]): FullSdlcStackVariant {
  if (!languages || languages.length === 0) return 'generic';
  const joined = languages.join(' ').toLowerCase();
  if (/(c#|csharp|\.net|dotnet)/.test(joined)) return 'dotnet';
  if (/(typescript|javascript|node)/.test(joined)) return 'node';
  if (/python/.test(joined)) return 'python';
  return 'generic';
}

export function resolveFullSdlcTemplate(
  stackOrLanguages?: FullSdlcStackVariant | string[] | { languages?: string[] }
): WorkflowDefinition {
  let stack: FullSdlcStackVariant = 'generic';
  if (typeof stackOrLanguages === 'string') {
    stack = stackOrLanguages;
  } else if (Array.isArray(stackOrLanguages)) {
    stack = detectStackFromLanguages(stackOrLanguages);
  } else if (stackOrLanguages && typeof stackOrLanguages === 'object' && Array.isArray(stackOrLanguages.languages)) {
    stack = detectStackFromLanguages(stackOrLanguages.languages);
  }
  return fullSdlcTemplate(stack);
}

export function builtInWorkflowTemplates(): WorkflowDefinition[] {
  return [
    governedDeliveryTemplate(),
    quickChangeTemplate()
  ];
}

/**
 * Full SDLC quality and security gate templates, published to the marketplace
 * as add-on packages rather than built-in to the application.
 */
export function fullSdlcMarketplaceTemplates(): WorkflowDefinition[] {
  return [
    fullSdlcTemplate('node'),
    fullSdlcTemplate('dotnet'),
    fullSdlcTemplate('python'),
    fullSdlcTemplate('generic'),
    ...sdlcLoopMarketplaceTemplates()
  ];
}

// ── Library assembly ─────────────────────────────────────────────────────

export interface AssembleTemplateLibraryInput {
  /** Defaults to `builtInWorkflowTemplates()`. */
  builtIn?: WorkflowDefinition[];
  /** Defaults to `fullSdlcMarketplaceTemplates()`. */
  marketplace?: WorkflowDefinition[];
  global?: WorkflowDefinition[];
  project?: Array<{ definition: WorkflowDefinition; path?: string }>;
}

/**
 * The templates offered to a project, in tier order: built-in, then marketplace,
 * then global, then project. Unlike the run catalog this does not collapse by id —
 * a user choosing a starting point should see every option, including a project
 * template that happens to share a built-in's id.
 */
export function assembleTemplateLibrary(input: AssembleTemplateLibraryInput = {}): WorkflowTemplate[] {
  const builtIn = (input.builtIn ?? builtInWorkflowTemplates()).map(
    (definition): WorkflowTemplate => ({ definition, source: 'built-in', builtIn: true })
  );
  const marketplace = (input.marketplace ?? fullSdlcMarketplaceTemplates()).map(
    (definition): WorkflowTemplate => ({ definition, source: 'marketplace', builtIn: false })
  );
  const global = (input.global ?? []).map(
    (definition): WorkflowTemplate => ({ definition, source: 'global', builtIn: false })
  );
  const project = (input.project ?? []).map(
    (entry): WorkflowTemplate => ({
      definition: entry.definition,
      source: 'project',
      builtIn: false,
      ...(entry.path ? { path: entry.path } : {})
    })
  );
  return [...builtIn, ...marketplace, ...global, ...project];
}

// ── Instantiation ────────────────────────────────────────────────────────

export interface InstantiateTemplateInput {
  template: WorkflowDefinition;
  projectId: string;
  /** New id for the project copy. Defaults to `<template.id>-<projectId>`. */
  newId?: string;
  /** New display name. Defaults to the template's name. */
  newName?: string;
  at: string;
}

/**
 * Copies a template into a project-scoped definition.
 *
 * The copy is deep, re-scoped to the project, reset to version 1, and stripped
 * of `builtIn`. Agent ids are carried across verbatim — the point of storing
 * ids rather than manifests is that the copy references the same catalog agents
 * without duplicating anything.
 */
export function instantiateTemplateForProject(input: InstantiateTemplateInput): WorkflowDefinition {
  const clone = JSON.parse(JSON.stringify(input.template)) as WorkflowDefinition;
  const { builtIn: _builtIn, ...rest } = clone;

  // A new workflow starts with a sensible tier on every agent stage that has none, so mapping the
  // tiers to models in Settings takes effect without editing each stage. An unmapped tier changes
  // nothing at run time (the run's model is used), and the author can change or clear any of them.
  const nodes = rest.nodes.map(node =>
    isAgentTaskNode(node) && !node.model && !node.modelTier ? { ...node, modelTier: defaultTierForStage(node) } : node
  );

  return {
    ...rest,
    nodes,
    id: input.newId ?? `${input.template.id}-${input.projectId}`,
    name: input.newName ?? input.template.name,
    scope: 'project',
    projectId: input.projectId,
    version: 1,
    createdAt: input.at,
    updatedAt: input.at
  };
}

/**
 * Turns an existing workspace workflow pack into an executable governed
 * template. The Markdown remains stage guidance; the generated approval node
 * supplies the executable hand-off and human gate that a pack alone cannot.
 */
export function promoteWorkflowPackToTemplate(input: {
  pack: AgentWorkflowReference;
  projectId: string;
  agentId: string;
  profileId?: string;
  hostId?: string;
  at: string;
}): WorkflowDefinition {
  const id = `pack-${input.pack.id}-${input.projectId}`.replace(/[^a-zA-Z0-9_-]+/g, '-');
  const stageId = 'pack-stage';
  const approvalId = 'approval';
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    name: `${input.pack.name} workflow`,
    description: input.pack.description ?? `Governed workflow generated from the ${input.pack.name} pack.`,
    scope: 'project',
    projectId: input.projectId,
    trigger: 'on-demand',
    version: 1,
    entryNodeId: stageId,
    createdAt: input.at,
    updatedAt: input.at,
    nodes: [
      {
        type: 'agent-task',
        id: stageId,
        name: input.pack.name,
        x: 0,
        y: 120,
        inputs: [],
        agent: {
          agentId: input.agentId,
          profileId: input.profileId ?? input.agentId,
          hostId: input.hostId ?? input.agentId,
          scope: 'global',
          toolMode: 'full'
        },
        instructions: `Execute the work described by the ${input.pack.name} workflow pack and return its required evidence.`,
        workflowPackId: input.pack.id,
        outputs: [{ id: 'pack-report', kind: 'report', required: true, description: 'The pack execution report.' }],
        mutatesWorktree: true
      },
      {
        type: 'approval',
        id: approvalId,
        name: 'Review and approve',
        x: 320,
        y: 120,
        inputs: ['pack-report'],
        prompt: `Review the output produced by ${input.pack.name}.`,
        requiredGates: [],
        allowBypass: false
      }
    ],
    edges: [{ id: 'pack-to-approval', from: stageId, to: approvalId, on: 'success', required: true }]
  };
}

/** Duplicates a definition in place (same scope), for "Save as a copy". */
export function duplicateWorkflowDefinition(
  definition: WorkflowDefinition,
  input: { newId: string; newName?: string; at: string }
): WorkflowDefinition {
  const clone = JSON.parse(JSON.stringify(definition)) as WorkflowDefinition;
  const { builtIn: _builtIn, ...rest } = clone;
  return {
    ...rest,
    id: input.newId,
    name: input.newName ?? `${definition.name} copy`,
    version: 1,
    createdAt: input.at,
    updatedAt: input.at
  };
}

// ── Dependencies & Readiness ─────────────────────────────────────────────

/**
 * Extracts and inspects all agent and skill dependencies declared across
 * the workflow's agent-task nodes, checking their status against the live catalog
 * and available definitions.
 */
export function extractWorkflowDependencies(
  workflow: WorkflowDefinition,
  catalog: AgentCatalogSnapshot,
  availableAgents: Record<string, unknown> = AVAILABLE_AGENT_DEFINITIONS,
  availableSkills: Record<string, unknown> = AVAILABLE_SKILL_DEFINITIONS
): WorkflowAgentDependency[] {
  type Entry = {
    profileId: string;
    hostId: string;
    providerId?: string;
    scope: 'global' | 'project';
    skills: Set<string>;
    nodeIds: string[];
  };
  const byBinding = new Map<string, Entry>();

  for (const node of workflow.nodes) {
    if (node.type !== 'agent-task') continue;
    const ref = node.agent;
    const profileId = ref.profileId ?? ref.agentId;
    const hostId = ref.hostId ?? ref.agentId;
    const key = `${ref.scope}:${profileId}:${hostId}:${ref.providerId ?? ''}`;
    let entry = byBinding.get(key);
    if (!entry) {
      entry = {
        profileId,
        hostId,
        ...(ref.providerId ? { providerId: ref.providerId } : {}),
        scope: ref.scope,
        skills: new Set<string>(),
        nodeIds: []
      };
      byBinding.set(key, entry);
    }
    entry.nodeIds.push(node.id);
    for (const skill of ref.skillNames ?? []) entry.skills.add(skill);
  }

  const runtimeHosts = catalog.runtimeHosts ?? catalog.agents;
  const out: WorkflowAgentDependency[] = [];
  for (const entry of byBinding.values()) {
    const host = runtimeHosts.find(candidate => candidate.manifest.id === entry.hostId);
    const hostInstalled = Boolean(host && host.trusted && host.errors.length === 0);
    const profile = catalog.profiles?.find(candidate => candidate.profile.id === entry.profileId);
    const profileInstalled = catalog.profiles === undefined
      ? entry.profileId === entry.hostId
      : Boolean(profile && profile.trusted && !profile.error);

    const skillNames = [...entry.skills];
    const missingSkills = skillNames.filter(name => !catalog.skills.some(skill => skill.metadata.name === name));
    const bundledBindingAvailable =
      entry.profileId === entry.hostId && Boolean(availableAgents[entry.hostId]);
    const hostAvailable = hostInstalled || Boolean(availableAgents[entry.hostId]);
    const profileAvailable = profileInstalled || bundledBindingAvailable;
    const skillsAvailable = missingSkills.every(name => Boolean(availableSkills[name]));

    let status: 'installed' | 'available' | 'missing';
    let reason: string | undefined;
    if (hostInstalled && profileInstalled && missingSkills.length === 0) {
      status = 'installed';
    } else if (hostAvailable && profileAvailable && skillsAvailable) {
      status = 'available';
      const missing: string[] = [];
      if (!profileInstalled) missing.push(`profile "${entry.profileId}"`);
      if (!hostInstalled) missing.push(`runtime host "${entry.hostId}"`);
      if (missingSkills.length) missing.push(`skills (${missingSkills.join(', ')})`);
      reason = `${missing.join(', ')} available for installation.`;
    } else {
      status = 'missing';
      if (!profileAvailable) reason = `Agent profile "${entry.profileId}" is not installed or available.`;
      else if (!hostAvailable) reason = `Runtime host "${entry.hostId}" is not installed or available.`;
      else reason = `Required skills (${missingSkills.filter(name => !availableSkills[name]).join(', ')}) are not available.`;
    }

    out.push({
      agentId: entry.hostId,
      profileId: entry.profileId,
      hostId: entry.hostId,
      ...(entry.providerId ? { providerId: entry.providerId } : {}),
      scope: entry.scope,
      skillNames,
      nodeIds: entry.nodeIds,
      status,
      ...(reason ? { reason } : {})
    });
  }

  return out;
}

/**
 * Assesses whether a template could actually run against the live catalog.
 *
 * Surfaced in the library so a user does not pick a template, wire it to a
 * project, and only discover at run time that `praxis-reviewer` was never
 * installed. Also identifies dependencies and whether missing ones can be
 * installed automatically upon selection.
 */
export function assessTemplateReadiness(
  template: WorkflowDefinition,
  catalog: AgentCatalogSnapshot,
  availableAgents: Record<string, unknown> = AVAILABLE_AGENT_DEFINITIONS,
  availableSkills: Record<string, unknown> = AVAILABLE_SKILL_DEFINITIONS
): TemplateReadiness {
  const structure = validateWorkflow(template);
  const preflight = preflightWorkflow(template.nodes, catalog);
  const dependencies = extractWorkflowDependencies(template, catalog, availableAgents, availableSkills);

  const blockingByNode: Record<string, string> = {};
  for (const [nodeId, result] of Object.entries(preflight.byNode)) {
    if (result.ok || result.failures.length === 0) continue;
    blockingByNode[nodeId] = result.failures[0].message;
  }

  const allResolvable = dependencies.length === 0 || dependencies.every(d => d.status === 'installed' || d.status === 'available');
  const hasAvailable = dependencies.some(d => d.status === 'available');

  return {
    templateId: template.id,
    structureOk: structure.valid,
    agentsOk: preflight.ok,
    blockingByNode,
    dependencies,
    autoInstallable: allResolvable && hasAvailable
  };
}
