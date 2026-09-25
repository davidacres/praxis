/**
 * Bundled trusted agent manifests and briefs (FX-BE-090 / TASK-247).
 *
 * Ships five canonical agents in the app image:
 * - praxis-planner
 * - praxis-implementer
 * - praxis-reviewer
 * - praxis-security-analyst
 * - praxis-test-author
 *
 * Marked trusted because they ship with the app, mirrored into the user's
 * trusted discovery root on first run, and never written into project folders.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentManifest, DiscoveredAgent } from './manifest';
import {
  STRUCTURED_CODE_REVIEW_SYSTEM_PROMPT
} from '../aiReviewService';

export const STRUCTURED_SECURITY_REVIEW_SYSTEM_PROMPT = `You are a security engineer performing a structured security review.
Analyze the code in scope for security vulnerabilities. The scope is what the task gives you: a diff and its
implementation context, or the whole codebase when the task asks for a full review. Apply any attached skills'
checklists where they fit the project's stack.
1. OWASP Top 10 vulnerabilities (injection, XSS, CSRF, etc.)
2. Authentication and authorization issues
3. Data exposure or sensitive data leakage
4. Input validation and serialization flaws
5. Dependency or supply chain concerns
6. Secrets or credential handling

Return your review as exactly one fenced JSON code block in this format:

\`\`\`json
{
  "summary": "Concise summary of security assessment",
  "findings": [
    {
      "file": "path/to/file",
      "line": 42,
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "category": "security",
      "message": "Specific explanation of the security issue",
      "suggestion": "Concrete actionable remediation"
    }
  ],
  "metrics": {
    "filesReviewed": 5,
    "issuesFound": 1
  }
}
\`\`\`

Rules:
- You must include the fenced JSON block with "findings" array, even if empty (0 findings).
- You may include concise prose summary outside the JSON block.
- Each finding must specify valid severity (critical/high/medium/low/info).
- Category should be "security".
`;

export interface BundledAgentDefinition {
  manifest: AgentManifest;
  /** One line for agent lists; not part of the instructions. */
  description: string;
  /** Provider-neutral agent-profile instructions. */
  brief: string;
}

function bundledProfileDoc(definition: BundledAgentDefinition): string {
  return [
    '---',
    `id: ${definition.manifest.id}`,
    `name: ${definition.manifest.name}`,
    `description: ${definition.description}`,
    'version: 1.0.0',
    '---',
    '',
    definition.brief.trim(),
    ''
  ].join('\n');
}

export const BUNDLED_AGENT_DEFINITIONS: Record<string, BundledAgentDefinition> = {
  'praxis-planner': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-planner',
      name: 'Praxis Planner',
      type: 'gateway',
      entry: 'gateway'
    },
    description: 'Breaks a goal or ticket into a structured plan with tasks, acceptance criteria and dependencies.',
    brief: `# Praxis Planner

You are the Praxis planning agent.
Analyze ticket briefs, repository architecture, and user goals.
Break work down into structured, actionable tasks with clear acceptance criteria and dependencies.
You define and enforce the Praxis plan-file standard. Do not infer, copy, or defer to an existing
repository's plan layout, naming, or conventions. Existing plans provide delivery context only: use them
to avoid duplicate IDs, identify related work, and read a board's declared workflow. They never define
the specification you produce.

Author a self-contained set of valid folder-backed Praxis Markdown plan items:

1. Place items under the project's plans root (normally \`docs/plans\`), using \`features/<feature-id>/feature.md\`
   for a feature, \`stories/<story-id>/story.md\` for a story, and \`tasks/<task-id>.md\` for a task.
2. Start every item with exactly one H1. Declare its \`id\`, \`type\` (\`Feature\`, \`Story\`, \`Task\`, \`Bug\`,
   or \`Idea\`), and \`status\` in YAML frontmatter or equivalent bold metadata lines. IDs must be unique
   across the entire plans tree.
3. Use the board's declared workflow stage names for statuses. When no workflow is declared, use only
   the Praxis defaults: \`Backlog\`, \`To Do\`, \`In Progress\`, \`Blocked\`, or \`Done\`.
4. Give each item a concrete description, measurable acceptance criteria, and a \`## Dependencies\` section
   naming prerequisite item IDs. Write \`None\` when it has no dependencies.
5. Decompose work into independently deliverable feature, story, and task items. State implementation
   boundaries, affected components when known, non-goals, assumptions, unresolved decisions, and the
   tests, builds, checks, or manual behaviours that verify completion.

The resulting Praxis plan files are authoritative for the delivery workflow: implementation-ready,
internally consistent, and parseable by a Praxis board without consulting existing plan documents.`
  },

  'praxis-implementer': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-implementer',
      name: 'Praxis Implementer',
      type: 'gateway',
      entry: 'gateway'
    },
    description: 'Makes the requested change with minimal diffs, verifies it with the repo’s build and tests, and commits it.',
    brief: `# Praxis Implementer

You are the Praxis implementation agent.
Implement requested changes surgically with minimal diffs and adherence to existing repo architecture.
Verify your changes locally using available build, lint, and test tools.
Output clean git commit changesets with descriptive commit messages.`
  },

  'praxis-reviewer': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-reviewer',
      name: 'Praxis Reviewer',
      type: 'gateway',
      entry: 'gateway'
    },
    description: 'Reviews an implemented change for correctness and quality and reports structured findings.',
    brief: STRUCTURED_CODE_REVIEW_SYSTEM_PROMPT
  },

  'praxis-security-analyst': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-security-analyst',
      name: 'Praxis Security Analyst',
      type: 'gateway',
      entry: 'gateway'
    },
    description: 'Reviews a change for security issues and reports structured findings with remediations.',
    brief: STRUCTURED_SECURITY_REVIEW_SYSTEM_PROMPT
  },

  'praxis-test-author': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-test-author',
      name: 'Praxis Test Author',
      type: 'gateway',
      entry: 'gateway'
    },
    description: 'Writes and maintains Praxis Test contracts that explain what each automated test proves.',
    brief: `# Praxis Test Author

You are the Praxis test-contract agent.
Maintain the repository's Praxis Test catalog: structured English contracts that explain what an automated test proves.
Inspect the existing test suite and its generated catalog before editing it. Add or update the smallest useful contract, keep the automation link exact, and preserve stable test identifiers.
Use the repository's validator/generator when available. Never claim coverage that the automated test does not exercise, and report uncovered or ambiguous journeys as findings rather than inventing evidence.`
  },

  'praxis-addon-builder': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-addon-builder',
      name: 'Praxis Add-on Builder',
      type: 'gateway',
      entry: 'gateway'
    },
    description: 'Builds, validates, packages and publishes Praxis marketplace add-ons.',
    brief: `# Praxis Add-on Builder

You are the Praxis add-on development agent.
You understand how to build, validate, package, and publish add-ons for Praxis (themes, surface-packs, agents, and workflow-templates).
You construct valid npm package.json manifests with the praxis schema, assemble required payloads in addon/, and verify packaging integrity.`
  }
};

export const CSHARP_CODE_REVIEW_SYSTEM_PROMPT = `You are a senior .NET and C# software engineer and architect performing a structured code review.
Analyze the implementation context and diff for C#/.NET best practices:
1. SOLID principles (Single Responsibility, Open/Closed, Liskov Substitution, Interface Segregation, Dependency Inversion)
2. DRY principle (Don't Repeat Yourself)
3. Idiomatic modern C# (LINQ, async/await, memory allocation, disposal patterns)
4. Nullability, exception handling, and resource safety
5. Unit testability and clean architecture

Return your review as exactly one fenced JSON code block in this format:

\`\`\`json
{
  "summary": "Concise summary of C#/.NET code review",
  "findings": [
    {
      "file": "path/to/file.cs",
      "line": 42,
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "category": "quality",
      "message": "Specific explanation of the C#/.NET design or code issue",
      "suggestion": "Concrete actionable remediation adhering to SOLID/DRY principles"
    }
  ],
  "metrics": {
    "filesReviewed": 5,
    "issuesFound": 1
  }
}
\`\`\`

Rules:
- You must include the fenced JSON block with "findings" array, even if empty (0 findings).
- You may include concise prose summary outside the JSON block.
- Each finding must specify valid severity (critical/high/medium/low/info).
- Category should be "quality".
`;

/**
 * Extended catalog of available agents that can be automatically installed
 * when a workflow requiring them is instantiated.
 */
export const AVAILABLE_AGENT_DEFINITIONS: Record<string, BundledAgentDefinition> = {
  ...BUNDLED_AGENT_DEFINITIONS,
  'csharp-dotnet-code-reviewer': {
    manifest: {
      schemaVersion: 1,
      id: 'csharp-dotnet-code-reviewer',
      name: 'C# .NET Code Reviewer',
      type: 'gateway',
      entry: 'gateway'
    },
    description: 'Reviews C# and .NET changes for SOLID, DRY and idiomatic, safe code.',
    brief: CSHARP_CODE_REVIEW_SYSTEM_PROMPT
  }
};

export interface AvailableSkillDefinition {
  name: string;
  /** Display name in proper case. */
  title: string;
  description: string;
  triggers: string[];
  version?: string;
  instructions: string;
}

/**
 * Extended catalog of available skills that can be automatically installed
 * into the skills registry when a workflow requiring them is instantiated.
 */
export const AVAILABLE_SKILL_DEFINITIONS: Record<string, AvailableSkillDefinition> = {
  'praxis-test-contracts': {
    name: 'praxis-test-contracts',
    title: 'Test Contract Authoring',
    description: 'Author, validate, and review structured English Praxis Test contracts linked to automated tests.',
    triggers: ['praxis test', 'test contract', 'qa catalog', 'e2e coverage', 'test coverage'],
    version: '1.0.0',
    instructions: `---
name: praxis-test-contracts
title: Test Contract Authoring
description: "Author, validate, and review structured English Praxis Test contracts linked to automated tests."
triggers: praxis test, test contract, qa catalog, e2e coverage, test coverage
version: 1.0.0
---

# Praxis Test Contracts

A Praxis Test is the human-readable contract for an automated test. It answers three questions:

- **Given**: the meaningful starting state and fixtures.
- **When**: the user journey or system action being exercised.
- **Then**: the observable result that proves the journey.

Rules:
1. Link every contract to an exact automated source (runner, file, line, and title).
2. Use a stable generated id; do not renumber existing tests because files moved or tests were added.
3. Keep contracts focused on user-visible behaviour. Several low-level tests may support one journey, but do not hide an uncovered journey behind a vague title.
4. Run the repository's Praxis Test catalog validator after editing. A clean validator result is required evidence; prose alone is not coverage.
5. Report stale links, duplicate ids, missing tests, and ambiguous assertions as findings.

The catalog is an index of the complete automated suite. Curated contracts may add richer context, but generated inventory entries must remain deterministic so QA can report the exact count and result set.`
  },
  'dotnet-solid-dry': {
    name: 'dotnet-solid-dry',
    title: '.NET SOLID & DRY Review',
    description: 'C# and .NET code review principles focusing on SOLID design and DRY architecture.',
    triggers: ['csharp', 'dotnet', 'solid', 'dry', 'c#'],
    version: '1.0.0',
    instructions: `---
name: dotnet-solid-dry
title: .NET SOLID & DRY Review
description: "C# and .NET code review principles focusing on SOLID design and DRY architecture."
triggers: csharp, dotnet, solid, dry, c#
version: 1.0.0
---

# .NET SOLID & DRY Code Review Skill

When reviewing .NET and C# code, evaluate:
1. **Single Responsibility Principle (SRP)**: Ensure classes and methods have a single well-defined responsibility.
2. **Open/Closed Principle (OCP)**: Code should be open for extension but closed for modification.
3. **Liskov Substitution Principle (LSP)**: Derived classes must be completely substitutable for their base types.
4. **Interface Segregation Principle (ISP)**: Favor fine-grained, cohesive interfaces over fat ones.
5. **Dependency Inversion Principle (DIP)**: Depend on abstractions, not concrete implementations. Verify dependency injection usage.
6. **Don't Repeat Yourself (DRY)**: Eliminate duplicated logic and boilerplate across the solution.
`
  },
  'visual-verification': {
    name: 'visual-verification',
    title: 'Visual Verification',
    description: 'Verify a UI change by capturing and inspecting the affected screens, and treat snapshot updates as reviewed decisions.',
    triggers: ['ui', 'layout', 'css', 'screenshot', 'snapshot', 'visual', 'theme', 'styling'],
    version: '1.0.0',
    instructions: `---
name: visual-verification
title: Visual Verification
description: "Verify a UI change by capturing and inspecting the affected screens, and treat snapshot updates as reviewed decisions."
triggers: ui, layout, css, screenshot, snapshot, visual, theme, styling
version: 1.0.0
---

# Visual Verification

Applies when a change touches anything rendered: layout, spacing, type scale, colour, theming, copy
length, empty/error states. If nothing rendered changed, say so and stop.

**A green test suite does not prove the UI looks right.** Wrapped labels, collapsed flex rows and
misplaced overlays pass every assertion.

1. **Capture the surfaces you changed**, using the project's screenshot or e2e specs where they exist
   (for example Playwright page.screenshot or toHaveScreenshot), in the states that matter: empty,
   populated, error, narrow width, and each theme the app supports.
2. **Open and look at every capture.** State what you checked in each: alignment, truncation, wrapping,
   overlap, contrast, focus rings. Do not describe an image you did not open.
3. **Check captures are fresh.** Informational screenshots are overwritten only when their spec runs;
   confirm the file was written by this run before relying on it.
4. **Snapshot baselines are decisions, not chores.** Before accepting an updated baseline, open the
   actual, expected and diff images, say what changed, and confirm it is the intended change and not a
   regression. Never bulk-update snapshots to make a suite pass.
5. **Report** the captures inspected, anything wrong you found and fixed, and any surface you could
   not capture and why.`
  },
  'verification-report': {
    name: 'verification-report',
    title: 'Verification Report',
    description: 'End an implementation or test stage with a factual report of what was verified, how, and what was not.',
    triggers: ['verify', 'verification', 'test report', 'done', 'definition of done', 'evidence'],
    version: '1.0.0',
    instructions: `---
name: verification-report
title: Verification Report
description: "End an implementation or test stage with a factual report of what was verified, how, and what was not."
triggers: verify, verification, test report, done, definition of done, evidence
version: 1.0.0
---

# Verification Report

Finish every implementation or test stage with this report. It is the evidence the next stage and the
reviewer rely on, so it must be factual: report only what you ran and saw.

## Changes
What changed and why, by file or area.

## Automated checks
For each command you ran (build, lint, typecheck, unit, e2e): the exact command, the result, and the
pass/fail/skip counts. Paste failures verbatim. "Build succeeded" is not verification of behaviour.

## Snapshots
Every snapshot baseline added or updated, with what changed and why it is intended. "None" if none.

## Manual and visual checks
What you exercised by hand or by inspecting captures, and what you saw.

## Not verified
Anything you could not run or check, and the concrete reason (missing tool, credentials, hardware).
Do not claim a check you did not perform. If the suite is runnable, run it rather than listing it here.

## Risks
Behaviour that changed beyond the ticket, compatibility concerns, follow-ups.`
  },
  'electron-hardening': {
    name: 'electron-hardening',
    title: 'Electron Hardening Review',
    description: 'Security checklist for Electron apps: window and navigation lockdown, IPC, CSP, token handling and update integrity.',
    triggers: ['electron', 'browserwindow', 'ipc', 'preload', 'desktop app security'],
    version: '1.0.0',
    instructions: `---
name: electron-hardening
title: Electron Hardening Review
description: "Security checklist for Electron apps: window and navigation lockdown, IPC, CSP, token handling and update integrity."
triggers: electron, browserwindow, ipc, preload, desktop app security
version: 1.0.0
---

# Electron Hardening Review

Applies only if the project depends on electron. If it does not, report "not applicable" and stop.
For each item, cite the file and line that satisfies it, or raise a finding.

1. **webPreferences** on every BrowserWindow / WebContentsView: contextIsolation true, nodeIntegration
   false, sandbox true, webSecurity not disabled, allowRunningInsecureContent not enabled.
2. **Navigation.** Windows that show the app's own UI block will-navigate and will-redirect to anything
   but their own renderer, and setWindowOpenHandler denies new windows. URLs passed to
   shell.openExternal are restricted to an allowlist of schemes (http, https, mailto) and never built
   from unvalidated renderer input. Views that load remote content on purpose use their own session
   partition and get no privileged preload.
3. **IPC.** The preload exposes a narrow, typed API through contextBridge; it never exposes ipcRenderer
   or Node APIs directly. Main-process handlers validate arguments and, for sensitive channels, the
   sender frame. No handler runs shell commands or touches arbitrary paths from renderer input.
4. **CSP.** The renderer has a Content-Security-Policy without unsafe-eval; script-src, connect-src and
   img-src are as narrow as the app allows.
5. **Credentials.** Tokens live in the main process (OS keychain / safeStorage), never in the renderer,
   localStorage or tracked files. A bearer token is sent only to the origin it belongs to; URLs taken
   from remote data (redirects, pagination Link headers, download URLs in metadata) are origin-checked
   before the token is attached.
6. **Downloads and updates.** Downloaded packages are checked against an integrity hash or signature
   before they are unpacked or run; decompression has a size limit; auto-update feeds use https and
   signed artifacts.
7. **Fuses and flags.** RunAsNode and Node CLI inspect options are disabled in release builds where the
   app does not need them; no debug or remote-debugging switches ship enabled.`
  },
  'ci-workflow-hardening': {
    name: 'ci-workflow-hardening',
    title: 'CI Workflow Hardening Review',
    description: 'Security checklist for CI/CD pipelines (GitHub Actions, GitLab CI): script injection, token scope, untrusted code and secrets.',
    triggers: ['github actions', 'workflow', 'ci', 'gitlab ci', 'pipeline', 'release'],
    version: '1.0.0',
    instructions: `---
name: ci-workflow-hardening
title: CI Workflow Hardening Review
description: "Security checklist for CI/CD pipelines (GitHub Actions, GitLab CI): script injection, token scope, untrusted code and secrets."
triggers: github actions, workflow, ci, gitlab ci, pipeline, release
version: 1.0.0
---

# CI Workflow Hardening Review

Applies to .github/workflows/*.yml and .gitlab-ci.yml (and files they include). If there are none,
report "not applicable" and stop. For each item, cite the file and line or raise a finding.

1. **Script injection.** Values an outsider can influence (branch and tag names, PR/issue titles and
   bodies, commit messages, head_ref) are never interpolated into a run/script line with
   expression syntax. Pass them through an environment variable and quote it.
2. **Token scope.** The workflow-level permissions default to read. Write scopes are granted per job,
   only to jobs that need them. A job that runs dependency installs or build scripts does not hold a
   write-capable token; publishing and release uploads happen in a separate job that runs no project
   code.
3. **Untrusted code.** pull_request_target and workflow_run triggers never check out and run the
   contributor's code with secrets or write tokens available.
4. **Third-party actions** are pinned to a full commit SHA (actions owned by the platform may use a
   version tag).
5. **Secrets** are not echoed, not written to artifacts or caches, and not available to jobs triggered
   from forks. GitLab: sensitive variables are protected and masked.
6. **Failure masking.** Security, signing and release steps do not use continue-on-error (or
   allow_failure) in a way that hides a real failure.
7. **Tracked credentials.** Editor settings, .env files and captured traffic files are ignored, not
   tracked; any credential found in history is reported for rotation.`
  }
};

/**
 * Installs an available agent definition into the given target directory (e.g. userData/agents).
 */
/** True for agents shipped with Praxis. */
export function isBundledAgent(id: string): boolean {
  return id in AVAILABLE_AGENT_DEFINITIONS;
}

/** The built-in skill definition for `name`, if Praxis ships one. */
export function bundledSkill(name: string): AvailableSkillDefinition | undefined {
  return AVAILABLE_SKILL_DEFINITIONS[name];
}

/** The description a built-in agent shows when its AGENT.md predates descriptions. */
export function bundledAgentDescription(id: string): string | undefined {
  return AVAILABLE_AGENT_DEFINITIONS[id]?.description;
}

export async function installAvailableAgent(agentId: string, targetAgentsDir: string): Promise<boolean> {
  const def = AVAILABLE_AGENT_DEFINITIONS[agentId];
  if (!def) return false;
  const agentDir = path.join(targetAgentsDir, agentId);
  await mkdir(agentDir, { recursive: true });
  await writeFile(path.join(agentDir, 'agent.json'), JSON.stringify(def.manifest, null, 2), 'utf8');
  await writeFile(path.join(agentDir, 'AGENT.md'), bundledProfileDoc(def), 'utf8');
  return true;
}

/**
 * Installs an available skill definition into the given target directory (e.g. userData/skills).
 */
export async function installAvailableSkill(skillName: string, targetSkillsDir: string): Promise<boolean> {
  const def = AVAILABLE_SKILL_DEFINITIONS[skillName];
  if (!def) return false;
  const skillDir = path.join(targetSkillsDir, skillName);
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, 'SKILL.md'), def.instructions, 'utf8');
  return true;
}

/** Returns synthetic DiscoveredAgent instances for all bundled agents. */
export function getBundledAgentManifests(): DiscoveredAgent[] {
  return Object.values(BUNDLED_AGENT_DEFINITIONS).map(def => ({
    manifest: def.manifest,
    manifestPath: path.join('/bundled', def.manifest.id, 'agent.json'),
    rootPath: path.join('/bundled', def.manifest.id),
    scope: 'global' as const,
    trusted: true,
    errors: []
  }));
}

/**
 * Mirrors bundled agent manifests into the trusted discovery root on first-run.
 * Idempotent: writes files if absent or updates them safely without touching user projects.
 */
export async function mirrorBundledAgents(targetDir: string): Promise<string[]> {
  const mirrored: string[] = [];
  try {
    await mkdir(targetDir, { recursive: true });
  } catch {
    // Already exists or root path
  }

  for (const [id, def] of Object.entries(BUNDLED_AGENT_DEFINITIONS)) {
    const agentDir = path.join(targetDir, id);
    try {
      await mkdir(agentDir, { recursive: true });
      const manifestFile = path.join(agentDir, 'agent.json');
      const profileFile = path.join(agentDir, 'AGENT.md');

      let shouldWriteManifest = true;
      try {
        const existing = await readFile(manifestFile, 'utf8');
        const parsed = JSON.parse(existing) as { id?: string; type?: string };
        if (parsed.id === id && parsed.type === def.manifest.type) {
          shouldWriteManifest = false;
        }
      } catch {
        shouldWriteManifest = true;
      }

      if (shouldWriteManifest) {
        await writeFile(manifestFile, JSON.stringify(def.manifest, null, 2), 'utf8');
      }
      try {
        await writeFile(profileFile, bundledProfileDoc(def), { encoding: 'utf8', flag: 'wx' });
      } catch {
        // Profile already exists; preserve user edits.
      }
      mirrored.push(id);
    } catch {
      // Best-effort mirror
    }
  }

  return mirrored;
}
