/**
 * Bundled trusted agent manifests and briefs (FX-BE-090 / TASK-247).
 *
 * Ships seven canonical agents in the app image:
 * - praxis-addon-builder
 * - praxis-planner
 * - praxis-implementer
 * - praxis-reviewer
 * - praxis-scheduler
 * - praxis-security-analyst
 * - praxis-skeptic
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
import { HUMAN_REVIEW_SESSION_PROMPT } from '../humanReview';

/**
 * The skeptic's brief (FX-BE-164). Its one job is to disprove: a finding survives only
 * when the code shows it is real. It returns the same findings shape with a verdict on
 * each, keeping the identifying fields byte-for-byte so a verdict lands on the finding
 * it judges (findings are matched by a fingerprint of rule, file, line and message).
 */
export const SKEPTIC_SYSTEM_PROMPT = `# Praxis Skeptic

You are a skeptical senior engineer. You are handed findings another reviewer raised about a change.
Your only job is to try to refute each one by reading the code. Do not raise new findings and do not fix anything.

For each finding:
- Open the file and line it names and read enough around it to judge it.
- Mark it "refuted" only when the code shows it is wrong: the bug cannot happen, the case is handled elsewhere,
  the reviewer misread the code, or it is a matter of taste presented as a defect. Say exactly why.
- Otherwise mark it "confirmed", with the evidence that convinced you. When in doubt, confirm: a refuted real bug
  ships, a confirmed false one only costs another pass.
- You may lower a severity that is clearly overstated; never raise one.

Return every finding you were given — none added, none dropped — as the last fenced JSON block of your reply:

\`\`\`json
{
  "summary": "How many findings survived and why the rest did not",
  "findings": [
    {
      "file": "copied exactly from the finding",
      "line": 42,
      "ruleId": "copied exactly, when the finding has one",
      "message": "copied exactly from the finding",
      "severity": "critical" | "high" | "medium" | "low" | "info",
      "category": "copied from the finding",
      "suggestion": "copied from the finding",
      "verdict": "confirmed" | "refuted",
      "verdictReason": "The evidence for your verdict, citing file and line"
    }
  ]
}
\`\`\`

Copy file, line, ruleId and message exactly: they identify the finding, and a changed one is treated as a different finding.`;

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
  /** Built-in skills attached when a session or workflow stage uses this agent. */
  skills?: string[];
}

function bundledProfileDoc(definition: BundledAgentDefinition): string {
  return [
    '---',
    `id: ${definition.manifest.id}`,
    `name: ${definition.manifest.name}`,
    `description: ${definition.description}`,
    ...(definition.skills?.length ? [`skills: ${definition.skills.join(', ')}`] : []),
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

  'praxis-scheduler': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-scheduler',
      name: 'Praxis Scheduler',
      type: 'gateway',
      entry: 'gateway'
    },
    description: 'Turns plan tasks into a scheduled-run draft, ordered by their dependencies, for a person to review and arm.',
    skills: ['praxis-scheduled-runs'],
    brief: `# Praxis Scheduler

You are the Praxis scheduling agent.
Prepare scheduled runs: ordered queues of plan tickets that Praxis runs one after another through a workflow.
Follow the praxis-scheduled-runs skill exactly. Read the plan items and their dependencies, choose the deliverable
leaf tickets, order them so every dependency runs first, and write a scheduled-run request file. Confirm the result
from the status file Praxis writes back, and fix and rewrite the request if it is rejected.
You only prepare drafts. Never arm, start or edit a schedule in Praxis's own data files, and never change plans or
workflows to make a schedule fit. Report what still blocks an unattended run instead of working around it.`
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

  'praxis-skeptic': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-skeptic',
      name: 'Praxis Skeptic',
      type: 'gateway',
      entry: 'gateway'
    },
    description: 'Tries to refute each finding in a review before it sends work back, so false findings do not cost a loop.',
    brief: SKEPTIC_SYSTEM_PROMPT
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
  },

  'praxis-human-reviewer': {
    manifest: {
      schemaVersion: 1,
      id: 'praxis-human-reviewer',
      name: 'Praxis Human Reviewer',
      type: 'gateway',
      entry: 'gateway'
    },
    description: 'Conducts an interactive human review of completed work, walking through high-level features with multiple-choice questions and free text to verify requirements.',
    brief: HUMAN_REVIEW_SESSION_PROMPT
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
  'praxis-scheduled-runs': {
    name: 'praxis-scheduled-runs',
    title: 'Scheduled Run Authoring',
    description: 'Prepare a Praxis scheduled run as an unarmed draft, with plan tasks ordered for execution, by writing a request file Praxis imports.',
    triggers: ['scheduled run', 'schedule tasks', 'overnight run', 'run queue', 'ordered tasks', 'schedule the plan'],
    version: '1.0.0',
    instructions: `---
name: praxis-scheduled-runs
title: Scheduled Run Authoring
description: "Prepare a Praxis scheduled run as an unarmed draft, with plan tasks ordered for execution, by writing a request file Praxis imports."
triggers: scheduled run, schedule tasks, overnight run, run queue, ordered tasks, schedule the plan
version: 1.0.0
---

# Scheduled Run Authoring

Use this when asked to schedule plan work: an ordered queue of tickets that Praxis runs one after
another, each through a workflow. You prepare the schedule as a **draft** by writing one request file.
You never drive the app, never edit Praxis's own data files, and never arm or start a schedule: a person
does that in Praxis after reviewing the draft.

## 1. Choose the tickets

1. Read the plan items (normally under \`docs/plans\`). Each has an \`id\` such as \`TASK-476\` and a
   \`## Dependencies\` section.
2. Queue the deliverable leaf items (tasks, bugs, or stories without tasks). Do not also queue their parent
   story or feature: the parent is context, and queuing it would run the same work twice.
3. Put each ticket after everything it depends on. Every dependency must be queued earlier, already done
   on the board, or listed in \`satisfiedDependencies\` because you confirmed it is finished. If unsure,
   set \`"order": "dependencies"\` and Praxis sorts the queue, keeping your order wherever it is free.
4. Refer to tickets by plan ID (\`TASK-476\`) or board key. Praxis resolves both; a plan ID that matches
   two items is rejected, so use the board key then.

## 2. Choose the workflow and start time

- Workflow: use the one the user names. Project workflows are \`.praxis/workflows/<id>.json\`; the file's
  \`id\` is the value to use. Omit \`workflowId\` to take the project's default. Praxis rejects an id the
  project cannot run and lists the valid ones.
- Each queued ticket starts its own workflow run. Check that the workflow suits unattended running: how
  approval gates pause it, and how a later ticket receives earlier tickets' code. Report what you find;
  do not edit the workflow to remove gates unless asked.
- Start time: use the date, time and IANA timezone the user gives. If none was given, pick a future time,
  and say plainly that it is a placeholder. The draft will not start at that time until someone arms it.

## 3. Write the request

Write \`.praxis/scheduled-runs/<short-name>.json\` in the project's workspace folder (the folder that holds
its \`.praxis\` directory and plans):

\`\`\`json
{
  "schemaVersion": 1,
  "kind": "praxis.scheduledRunRequest",
  "name": "Durable team chat - ordered tasks",
  "workflowId": "full-sdlc",
  "date": "2026-11-02",
  "time": "21:00",
  "timezone": "Europe/London",
  "order": "as-listed",
  "tickets": ["TASK-476", "TASK-477", "TASK-478"],
  "satisfiedDependencies": []
}
\`\`\`

- Required: \`schemaVersion\`, \`kind\`, \`name\`, \`date\` (YYYY-MM-DD), \`time\` (HH:mm, 24-hour),
  \`timezone\`, \`tickets\`.
- \`order\`: \`as-listed\` (default) keeps your order and rejects one that breaks a dependency;
  \`dependencies\` sorts it.
- \`projectId\`: only needed when several Praxis projects share the folder; the status file names them.
- Do not put request files under \`docs/plans\`, where they would be read as plan items.

## 4. Confirm the result

While Praxis is running it checks the folder every few seconds (and on its next launch otherwise), then
writes \`<short-name>.status.json\` beside the request:

- \`"state": "imported"\`: the draft exists. Check \`entries\` is the order you intended, and read
  \`warnings\` (for example a ticket already done, or a start time in the past).
- \`"state": "rejected"\`: nothing was saved. Fix every item in \`errors\` and rewrite the request.

The status describes the request only when its \`requestHash\` equals the SHA-256 of the request file
(\`shasum -a 256 <file>\`); otherwise Praxis has not read your latest version yet. If no status appears,
Praxis is probably closed: say the request will be imported when it next starts.

## 5. Change or replace a draft

Rewrite the same file to update its draft: entries you keep retain their identity. A request can only
change its schedule while it is still a draft; once it is armed or has run, use a new file name for a new
draft. Deleting the request file does not delete the draft; deleting the draft in Praxis does not bring it
back unless the request changes.

## 6. Hand over

Report: the draft name and \`runId\`, the ordered tickets (plan ID, board key, title), the workflow, the
start time and whether it is a placeholder, any warnings, and what still blocks an unattended run (approval
gates, how code carries between tickets, workspace trust, uncommitted changes, providers). Tell the user to
review and arm it in Praxis's Scheduled runs view.`
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

/** Skills Praxis installs for every user, not only when a workflow asks for them. */
export const BUNDLED_SKILL_NAMES: readonly string[] = ['praxis-scheduled-runs'];

function skillVersion(doc: string): string | undefined {
  return /^version:\s*(\S+)/m.exec(doc)?.[1];
}

/**
 * Installs the always-on bundled skills into the user's skills root. A missing
 * skill is written; one from an older bundled version is replaced; one at the
 * current version is left alone, so a user's edits survive until Praxis ships
 * a new version of it.
 */
export async function mirrorBundledSkills(targetSkillsDir: string): Promise<string[]> {
  const mirrored: string[] = [];
  for (const name of BUNDLED_SKILL_NAMES) {
    const def = AVAILABLE_SKILL_DEFINITIONS[name];
    if (!def) continue;
    const file = path.join(targetSkillsDir, name, 'SKILL.md');
    try {
      const existing = await readFile(file, 'utf8').catch(() => undefined);
      if (existing !== undefined && skillVersion(existing) === skillVersion(def.instructions)) {
        mirrored.push(name);
        continue;
      }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, def.instructions, 'utf8');
      mirrored.push(name);
    } catch {
      // Best-effort mirror
    }
  }
  return mirrored;
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
