import type { WorkflowDefinition, WorkflowNode } from '@praxis/core';

export interface WorkflowTemplateGuidance {
  bestFor: string;
  summary: string;
  stack?: string;
  highlights: string[];
}

export function getWorkflowTemplateGuidance(definition: WorkflowDefinition): WorkflowTemplateGuidance {
  const id = definition.id.toLowerCase();

  if (id === 'governed-delivery') {
    return {
      bestFor: 'Standard feature development requiring automated QA and security checks plus human sign-off before shipping.',
      summary: 'Plan, implement, and converge parallel review, QA, and security gates before release.',
      stack: 'Universal',
      highlights: [
        'Parallel Code Review, QA testing, and Security checks before approval',
        'Deterministic checks for QA and Security prevent model hallucination',
        'Explicit human approval stage prior to merge or release'
      ]
    };
  }

  if (id === 'quick-change') {
    return {
      bestFor: 'Rapid bugfixes, minor hotfixes, documentation updates, or prototyping.',
      summary: 'Direct single-stage implementation followed by human approval without automated gate overhead.',
      stack: 'Universal',
      highlights: [
        'Lightweight and fast with zero automated check delays',
        'Ideal for low-risk changes and exploratory tasks',
        'Full implementation worktree tracking with manual sign-off'
      ]
    };
  }

  if (id === 'full-sdlc' || id === 'full-sdlc-node') {
    return {
      bestFor: 'Production Node.js and TypeScript repositories requiring rigorous quality, security, and supply-chain gates.',
      summary: '12-stage pipeline with ESLint, TypeScript compiler, Vitest/Jest, Semgrep SAST, Gitleaks, npm audit, and structured review.',
      stack: 'Node.js / TypeScript',
      highlights: [
        'Native Node checks: ESLint, tsc, and Vitest/Jest with coverage reporting',
        'Tri-part security: Semgrep SAST, Gitleaks secret scanning, and npm audit SCA',
        'Automated review-fix loop between reviewer and implementer agents',
        'Threshold gates enforcing 80% line coverage and 0 high/critical issues'
      ]
    };
  }

  if (id === 'full-sdlc-dotnet') {
    return {
      bestFor: 'Enterprise .NET and C# applications using dotnet CLI and specialized C# review agents.',
      summary: '12-stage pipeline with dotnet format, dotnet test, Semgrep C# SAST, Gitleaks, osv-scanner, and C# review agent.',
      stack: '.NET / C#',
      highlights: [
        'Native dotnet CLI checks: dotnet format and dotnet test with coverage',
        'C# SAST and NuGet dependency vulnerability auditing via osv-scanner',
        'csharp-dotnet-code-reviewer agent equipped with dotnet-solid-dry skill',
        'Audited security and QA gate thresholds with expiring waivers'
      ]
    };
  }

  if (id === 'full-sdlc-python') {
    return {
      bestFor: 'Python backend services, APIs, and data applications using Ruff, Pytest, and Bandit.',
      summary: '12-stage pipeline with Ruff linter, Pytest coverage, Bandit SAST, Gitleaks, and pip-audit.',
      stack: 'Python',
      highlights: [
        'Ruff linter/formatter + Pytest with lcov coverage',
        'Bandit Python security analysis and pip-audit dependency audits',
        'Structured Python code review with inline comments and fix loop',
        'Automated post-approval deployment stage'
      ]
    };
  }

  if (id === 'full-sdlc-loop' || id === 'full-sdlc-loop-node') {
    return {
      bestFor: 'Node.js and TypeScript teams that want the full SDLC plus dedicated BDD, test-review, security-review, and advisory UI/UX review stages.',
      summary: '16-stage iterative pipeline: BDD scenarios authored before code, then parallel lint, types, unit tests, BDD run, SAST, secrets, SCA, and four review agents.',
      stack: 'Node.js / TypeScript',
      highlights: [
        'BDD scenarios authored from the plan and executed via Cucumber with JUnit reporting',
        'Separate code review, automated test review, and security review agents over one diff',
        'Advisory UI/UX review reports findings without blocking delivery',
        'Every failed stage retries within its budget; thresholds (80% coverage, 0 high findings) hold approval'
      ]
    };
  }

  if (id === 'full-sdlc-loop-dotnet') {
    return {
      bestFor: '.NET teams wanting the full SDLC with BDD scenarios, test review, security review, and advisory UX review.',
      summary: '16-stage pipeline with dotnet format/build/test + coverlet, Semgrep, Gitleaks, Reqnroll/SpecFlow BDD, and four review agents.',
      stack: '.NET / C#',
      highlights: [
        'BDD scenarios authored before code; run step left as a clearly marked placeholder for Reqnroll/SpecFlow',
        'csharp-dotnet-code-reviewer reviews code; the security analyst reviews what scanners miss',
        'Advisory UI/UX review that can never false-block a delivery',
        'Threshold gates enforce 80% line coverage and zero high-or-worse findings'
      ]
    };
  }

  if (id === 'full-sdlc-loop-python') {
    return {
      bestFor: 'Python teams wanting the full SDLC with behave BDD scenarios, test review, security review, and advisory UX review.',
      summary: '16-stage pipeline with Ruff, mypy, pytest coverage, Bandit-era Semgrep SAST, Gitleaks, behave BDD with JUnit output, and four review agents.',
      stack: 'Python',
      highlights: [
        'BDD scenarios authored from the plan, executed with behave --junit',
        'Automated test review checks scenarios and unit tests for real coverage of behaviour',
        'Security review agent covers authorization and business-logic risks scanners cannot see',
        'Failed stages retry within budget; gate thresholds hold approval until clean'
      ]
    };
  }

  if (id === 'full-sdlc-loop-generic') {
    return {
      bestFor: 'Polyglot projects wanting the complete iterative SDLC structure with commands left for the team to fill.',
      summary: 'Language-agnostic 16-stage DAG: BDD authoring, parallel QA/security/review band with four review agents, thresholds, and bounded retry.',
      stack: 'Generic / Polyglot',
      highlights: [
        'Complete iterative DAG ready for custom lint, test, BDD, SAST, and SCA commands',
        'BDD scenarios authored before implementation, reviewed alongside automated tests',
        'Advisory UI/UX review included; its findings never block approval',
        'Iterates by bounded retries plus gate-held approval instead of unbounded loops'
      ]
    };
  }

  if (id === 'full-sdlc-generic') {
    return {
      bestFor: 'Polyglot projects or custom toolchains needing a complete 12-stage SDLC quality and security structure.',
      summary: 'Language-agnostic 12-stage DAG with parallel lint, typecheck, test, SAST, secrets, SCA, review, and gate thresholds.',
      stack: 'Generic / Polyglot',
      highlights: [
        'Complete 12-stage DAG ready for custom lint, test, SAST, and SCA commands',
        'Multi-owner security gate combining secrets, SAST, and SCA scanners',
        'Structured reviewer contract with inline delivery and bounded fix loop',
        'Observe-mode ready to ingest CI security and quality reports'
      ]
    };
  }

  // Dynamic derivation for custom / marketplace templates
  const nodeCount = definition.nodes.length;
  const checks = definition.nodes.filter(n => n.type === 'check');
  const agentTasks = definition.nodes.filter(n => n.type === 'agent-task');
  const approval = definition.nodes.find(n => n.type === 'approval');
  const requiredGates = approval && approval.type === 'approval' ? approval.requiredGates : [];

  const highlights: string[] = [
    `${nodeCount} stages (${agentTasks.length} agent tasks, ${checks.length} automated checks)`
  ];
  if (requiredGates.length > 0) {
    highlights.push(`Enforces ${requiredGates.join(', ').toUpperCase()} gates prior to approval`);
  }
  if (checks.some(c => c.type === 'check' && c.observe?.enabled)) {
    highlights.push('Supports observe-mode ingestion of CI security reports');
  }

  return {
    bestFor: definition.description || `Custom workflow pipeline with ${nodeCount} stages.`,
    summary: definition.description || `${definition.name} delivery pipeline.`,
    stack: 'Custom',
    highlights
  };
}

export interface StageFlowStep {
  id: string;
  name: string;
  type: WorkflowNode['type'];
  detail?: string;
  isGate?: boolean;
}

/**
 * Traces a human-readable sequence of stages from the entry node through the edges.
 */
export function getWorkflowStageSequence(definition: WorkflowDefinition): StageFlowStep[] {
  const nodeMap = new Map<string, WorkflowNode>(definition.nodes.map(n => [n.id, n]));
  const steps: StageFlowStep[] = [];
  const visited = new Set<string>();

  // Topological / BFS traversal starting from entryNodeId
  const queue: string[] = [definition.entryNodeId];

  while (queue.length > 0) {
    const currentId = queue.shift()!;
    if (visited.has(currentId)) continue;
    visited.add(currentId);

    const node = nodeMap.get(currentId);
    if (!node) continue;

    let detail: string | undefined;
    let isGate = false;

    if (node.type === 'agent-task') {
      detail = `Agent: ${node.agent.agentId}`;
      if (node.satisfiesGate) isGate = true;
    } else if (node.type === 'check') {
      detail = `Check: ${node.command} ${(node.args || []).slice(0, 2).join(' ')}`;
      if (node.satisfiesGate) isGate = true;
    } else if (node.type === 'approval') {
      detail = node.requiredGates.length > 0 ? `Gates: ${node.requiredGates.join(', ')}` : 'Manual sign-off';
    } else if (node.type === 'deployment') {
      detail = 'Deploy release';
      if (node.satisfiesGate) isGate = true;
    } else if (node.type === 'join') {
      detail = 'Gate convergence';
    }

    steps.push({
      id: node.id,
      name: node.name,
      type: node.type,
      detail,
      isGate
    });

    const outbound = definition.edges.filter(e => e.from === currentId).map(e => e.to);
    for (const nextId of outbound) {
      if (!visited.has(nextId) && !queue.includes(nextId)) {
        queue.push(nextId);
      }
    }
  }

  // Include any disconnected nodes at the end
  for (const node of definition.nodes) {
    if (!visited.has(node.id)) {
      steps.push({
        id: node.id,
        name: node.name,
        type: node.type
      });
    }
  }

  return steps;
}
