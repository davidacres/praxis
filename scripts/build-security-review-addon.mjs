#!/usr/bin/env node
// SPDX-License-Identifier: MIT
/**
 * Generates the Security Review marketplace workflow's template:
 *   addons/workflows/security-review/addon/template.json
 *
 * The template is data, but its scanner stages are shell scripts and its agent stages are long
 * briefs — both far easier to maintain here than as escaped JSON. Edit this file, run it, and
 * commit both. Publish with: node scripts/publish-addon.mjs addons/workflows/security-review
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOW = '2026-09-24T00:00:00.000Z';
const TWENTY_MIN = 20 * 60 * 1000;

const analyst = { agentId: 'praxis-security-analyst', profileId: 'praxis-security-analyst', hostId: 'praxis-security-analyst', scope: 'global', toolMode: 'read-only' };
const planner = { agentId: 'praxis-planner', profileId: 'praxis-planner', hostId: 'praxis-planner', scope: 'global', toolMode: 'read-only' };

// Every scanner is optional: a missing tool is reported as SKIPPED, and a tool
// that finds problems still exits 0 here — the logs are evidence for the
// review stage, not a pass/fail verdict.
const sh = script => ({ command: 'sh', args: ['-c', script] });

const inventory = sh([
  'echo "== Repository =="',
  'echo "commit: $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"',
  'echo "tracked files: $(git ls-files 2>/dev/null | wc -l | tr -d " ")"',
  'echo',
  'echo "== File types (top 20) =="',
  "git ls-files 2>/dev/null | sed -n 's/.*\\.\\([A-Za-z0-9]*\\)$/\\1/p' | sort | uniq -c | sort -rn | head -20",
  'echo',
  'echo "== Dependency manifests and lockfiles =="',
  "git ls-files 2>/dev/null | grep -E '(^|/)(package\\.json|package-lock\\.json|npm-shrinkwrap\\.json|pnpm-lock\\.yaml|yarn\\.lock|requirements[^/]*\\.txt|pyproject\\.toml|Pipfile\\.lock|poetry\\.lock|uv\\.lock|go\\.mod|Cargo\\.lock|Gemfile\\.lock|pom\\.xml|build\\.gradle(\\.kts)?|[^/]*\\.csproj|packages\\.lock\\.json|Directory\\.Packages\\.props|composer\\.lock)$' | head -60",
  'echo',
  'echo "== Security-relevant config =="',
  "git ls-files 2>/dev/null | grep -Ei '(^|/)(Dockerfile[^/]*|docker-compose[^/]*\\.ya?ml|\\.github/workflows/[^/]+\\.ya?ml|\\.gitlab-ci\\.yml|[^/]*\\.tf|nginx[^/]*\\.conf|\\.env[^/]*|[^/]*secret[^/]*|[^/]*credential[^/]*)$' | grep -v '\\.md$' | head -60",
  'echo',
  'echo "== Scanners available =="',
  'for t in semgrep gitleaks osv-scanner npm pip-audit dotnet; do if command -v "$t" >/dev/null 2>&1; then echo "$t: yes"; else echo "$t: no"; fi; done',
  'exit 0'
].join('\n'));

const sast = sh([
  'if command -v semgrep >/dev/null 2>&1; then',
  '  semgrep scan --config=p/default --metrics=off --quiet --text --timeout=60 .',
  '  echo "[semgrep exited $?]"',
  'else',
  '  echo "SKIPPED: semgrep is not installed (brew install semgrep, or pipx install semgrep)."',
  'fi',
  'exit 0'
].join('\n'));

const secrets = sh([
  'if command -v gitleaks >/dev/null 2>&1; then',
  '  echo "== Working tree =="',
  '  gitleaks detect --source . --no-git --redact --no-banner -v --no-color --log-level=warn',
  '  echo "[gitleaks working tree exited $?]"',
  '  echo',
  '  echo "== Git history =="',
  '  gitleaks detect --source . --redact --no-banner -v --no-color --log-level=warn',
  '  echo "[gitleaks history exited $?]"',
  'else',
  '  echo "SKIPPED: gitleaks is not installed (brew install gitleaks)."',
  'fi',
  'exit 0'
].join('\n'));

const dependencies = sh([
  'ran=0',
  'if command -v osv-scanner >/dev/null 2>&1; then',
  // --no-ignore: a run works in a worktree under the repo (e.g. .worktrees/), which the repo's own
  // .gitignore usually ignores, and osv-scanner honours it and would otherwise scan nothing.
  '  osv-scanner --recursive --no-ignore .',
  '  echo "[osv-scanner exited $?]"',
  '  ran=1',
  'else',
  '  echo "osv-scanner is not installed (brew install osv-scanner); falling back to ecosystem auditors."',
  '  if [ -f package-lock.json ] && command -v npm >/dev/null 2>&1; then npm audit; echo "[npm audit exited $?]"; ran=1; fi',
  '  if [ -f requirements.txt ] && command -v pip-audit >/dev/null 2>&1; then pip-audit -r requirements.txt; echo "[pip-audit exited $?]"; ran=1; fi',
  '  if command -v dotnet >/dev/null 2>&1 && ls *.sln *.csproj >/dev/null 2>&1; then dotnet list package --vulnerable --include-transitive; echo "[dotnet list package exited $?]"; ran=1; fi',
  'fi',
  'if [ "$ran" = 0 ]; then echo "SKIPPED: no dependency scanner applicable to this repository is installed."; fi',
  'exit 0'
].join('\n'));

const WHOLE_REPO =
  'Scope: this is a review of the WHOLE repository at its current commit, not of a diff or a single change — ' +
  'ignore any part of your standing brief that assumes a change under review. ';

const NO_SECRETS =
  'Never reproduce a secret, token, password or key value; refer to it by file:line and type only. ';

const reconInstructions =
  WHOLE_REPO +
  'Map the attack surface so the next stage knows where to look. Do not hunt for or report vulnerabilities yet, and do not return a JSON block. ' +
  'Start from the "repo-inventory" log (languages, manifests, config files, which scanners are installed), then read the code. ' +
  'Return a markdown report of at most about 5,000 characters (later stages receive it trimmed) with these sections: ' +
  '1. System overview — components, languages, frameworks, how it runs and is deployed. ' +
  '2. Entry points and trust boundaries — HTTP routes, IPC/RPC handlers, CLI arguments, webhooks, queues, file and URL parsing, deserialization, child processes, plugin/extension loading; each with file paths. ' +
  '3. Sensitive assets — credentials, tokens, keys, personal data: where they are created, stored, logged and transmitted. ' +
  '4. Authentication and authorization model — who can do what, and where it is enforced. ' +
  '5. Security-relevant configuration — CSP, CORS, TLS, cookies, sandboxing (e.g. Electron webPreferences), containers, CI/CD workflows and their permissions. ' +
  '6. Supply chain — dependency managers, lockfiles, install scripts, pinned vs floating versions. ' +
  '7. Review priorities — the 10 areas most likely to hold serious issues, ranked, each with a one-line reason. ' +
  NO_SECRETS;

const reviewInstructions =
  WHOLE_REPO +
  'Perform an in-depth security review and write the security report. ' +
  'Inputs, all included below: the "attack-surface" report from the previous stage, and the output of the scanner stages ("sast-log", "secrets-log", "dependency-log"). A log that says SKIPPED means that tool is not installed — say so in the report and compensate with manual review of that area; a missing log means that scanner failed or timed out. ' +
  'Method: (a) triage every scanner result — confirm it by reading the code, or dismiss it as a false positive with a reason; (b) manually review the ranked priority areas and every entry point, covering the OWASP Top 10 and ASVS themes: injection (SQL, command, path traversal, template, prototype pollution), broken access control and IDOR, authentication and session handling, cryptography misuse, sensitive data exposure and logging, SSRF, unsafe deserialization, XSS/CSP, insecure defaults and misconfiguration, secrets in code or history, vulnerable or unpinned dependencies, CI/CD and supply-chain risk, and business-logic abuse; (c) trace data flow from source to sink before claiming a finding. ' +
  'Report only issues you verified in the code. Put anything plausible but unconfirmed under "Needs verification" rather than inflating it. ' +
  'Severity: Critical — remotely exploitable without special access, leading to code execution, full data compromise or auth bypass; High — exploitable with low-privilege access or common conditions, significant impact; Medium — needs unusual conditions or has limited impact; Low — defence-in-depth or hard to exploit; Info — hardening advice. ' +
  'Every finding carries: an ID (SEC-001, SEC-002, … in severity order), title, severity, CWE id, location (file:line, several if needed), evidence (what the code does, a short excerpt at most), an exploit scenario, the remediation, and an effort estimate (S = under a day, M = days, L = a week or more). ' +
  NO_SECRETS +
  'Return the report as your final response, in markdown, in exactly this order (the first and last sections must stay complete even if a reader trims the middle): ' +
  '"# Security Review Report", ' +
  '"## Executive summary" (overall risk rating, finding counts by severity, the three most important risks in one line each), ' +
  '"## Scope and method" (commit, what was reviewed, which scanners ran or were skipped, anything out of scope), ' +
  '"## Findings" (full detail, highest severity first), ' +
  '"## Needs verification", ' +
  '"## Scanner triage" (dismissed scanner results and why), ' +
  '"## Positive observations", ' +
  'and last "## Findings register" — a markdown table with columns ID | Severity | Title | CWE | Location | Effort, one row per finding. ' +
  'After the report, end with the JSON findings block described below: one entry per finding in the register, with "message" starting with the finding ID and title (e.g. "SEC-001 SQL injection in order search: …"), "category" set to the CWE id, and "suggestion" set to the remediation. Put "Needs verification" items in it with severity "info".';

const planInstructions =
  'Create a prioritised remediation plan for the findings in the "security-report" (inline below). It becomes a feature on this project\'s board with one work item per entry, so write each item so an engineer can pick it up cold. ' +
  'A long report arrives trimmed in the middle, with a note naming a file that holds all of it — read that file first, so every finding in the register is planned. Re-open the cited source files to confirm the detail of each finding you plan, and do not invent findings that are not in the report. Do not change any code. ' +
  'Prioritise by severity × exploitability × exposure, then pull forward quick wins (high risk reduction for small effort): ' +
  'P0 — fix immediately (critical, or high and reachable from an untrusted boundary); ' +
  'P1 — fix in the next iteration; ' +
  'P2 — schedule; ' +
  'P3 — hardening backlog. ' +
  'Group findings that share a root cause or a fix into one work item (type "Bug" for a vulnerability fix, "Task" for hardening or tooling). Give every item a "severity": the worst severity among the findings it resolves. A Bug also gets "steps" (how the weakness is exercised — the exploit scenario, as numbered steps), "expected" (the secure behaviour) and "actual" (what the code does today); these fill the bug\'s own sections on the board. Each item\'s description is markdown with these sections: "Findings" (the SEC ids it resolves, with severity and location), "Why this priority", "Change" (which files and what to change), "Verification" (a test, scanner rule or manual check that proves the issue is gone and stays gone), "Effort" (S = under a day, M = days, L = a week or more), "Depends on" (other items by title, or none) and "Risk" (what the change itself could break). ' +
  'The feature title is "Security remediation — " followed by today\'s date (YYYY-MM-DD). Its description holds: a summary (items per priority, total effort, what is fixed first and why), a suggested sequence of phases a team could ship one at a time, "Decisions needed" (findings that need an owner\'s call — accept, mitigate elsewhere, or out of scope; these get no item), and a "Coverage" table mapping every finding ID in the register to its item title, so nothing is dropped. ' +
  'Before the block, give a short markdown overview of the plan for the person reading this run.';

const definition = {
  schemaVersion: 1,
  id: 'security-review',
  name: 'Security Review',
  description:
    'Whole-codebase security review: maps the attack surface, runs whichever of Semgrep, Gitleaks and OSV-Scanner (or npm audit / pip-audit / dotnet) are installed, triages their output with an in-depth manual review, and writes a severity-ranked report with structured findings. Then approve to create a prioritised (P0–P3) remediation plan on the project board, or skip it. Scanner stages need macOS or Linux.',
  trigger: 'on-demand',
  scope: 'global',
  version: 1,
  entryNodeId: 'inventory',
  createdAt: NOW,
  updatedAt: NOW,
  nodes: [
    {
      type: 'check',
      id: 'inventory',
      name: 'Repository inventory',
      x: 0,
      y: 165,
      inputs: [],
      ...inventory,
      successExitCodes: [0],
      outputs: [{ id: 'repo-inventory', kind: 'log', required: true, description: 'Languages, manifests, security-relevant config files and which scanners are installed.' }],
      timeoutMs: 5 * 60 * 1000
    },
    {
      type: 'agent-task',
      id: 'recon',
      name: 'Attack surface',
      x: 260,
      y: 0,
      inputs: ['repo-inventory'],
      agent: analyst,
      instructions: reconInstructions,
      outputs: [{ id: 'attack-surface', kind: 'report', required: true, description: 'Entry points, trust boundaries, sensitive assets and ranked review priorities.' }],
      mutatesWorktree: false,
      maxAttempts: 2
    },
    {
      type: 'check',
      id: 'sast',
      name: 'SAST (Semgrep)',
      x: 260,
      y: 110,
      inputs: [],
      ...sast,
      successExitCodes: [0],
      outputs: [{ id: 'sast-log', kind: 'log', required: true }],
      timeoutMs: TWENTY_MIN
    },
    {
      type: 'check',
      id: 'secrets',
      name: 'Secrets (Gitleaks)',
      x: 260,
      y: 220,
      inputs: [],
      ...secrets,
      successExitCodes: [0],
      outputs: [{ id: 'secrets-log', kind: 'log', required: true }],
      timeoutMs: TWENTY_MIN
    },
    {
      type: 'check',
      id: 'dependencies',
      name: 'Dependency vulnerabilities',
      x: 260,
      y: 330,
      inputs: [],
      ...dependencies,
      successExitCodes: [0],
      outputs: [{ id: 'dependency-log', kind: 'log', required: true }],
      timeoutMs: TWENTY_MIN
    },
    { type: 'join', id: 'evidence', name: 'Evidence gathered', x: 520, y: 165, inputs: [], mode: 'all' },
    {
      type: 'agent-task',
      id: 'review',
      name: 'Security review',
      x: 760,
      y: 165,
      inputs: ['attack-surface', 'sast-log', 'secrets-log', 'dependency-log'],
      agent: analyst,
      instructions: reviewInstructions,
      outputs: [
        { id: 'security-report', kind: 'report', required: true, description: 'Severity-ranked security report with a findings register.' },
        { id: 'security-findings', kind: 'findings', required: true, description: 'Every finding, structured: file, line, severity, CWE and fix.' }
      ],
      mutatesWorktree: false,
      maxAttempts: 2
    },
    {
      type: 'approval',
      id: 'plan-decision',
      name: 'Create remediation plan?',
      x: 1000,
      y: 165,
      inputs: ['security-report'],
      prompt:
        'The security report is ready — open it from the "Security review" stage. Approve to turn its findings into a prioritised remediation plan on this project\'s board, or skip if the report is all you need.',
      requiredGates: [],
      allowBypass: false,
      optional: true
    },
    {
      type: 'agent-task',
      id: 'remediation-plan',
      name: 'Remediation plan',
      x: 1240,
      y: 165,
      inputs: ['security-report'],
      agent: planner,
      instructions: planInstructions,
      outputs: [{ id: 'remediation-plan', kind: 'plan', required: true, publishTo: 'board', description: 'A feature on the project board with prioritised (P0–P3) work items covering every finding.' }],
      mutatesWorktree: false,
      maxAttempts: 2
    }
  ],
  edges: [
    { id: 'e-inventory-recon', from: 'inventory', to: 'recon', on: 'success', required: true },
    // Scanners are advisory: a timeout must not sink the review, so they run
    // off non-required edges and reach the join on `always`.
    { id: 'e-inventory-sast', from: 'inventory', to: 'sast', on: 'success', required: false },
    { id: 'e-inventory-secrets', from: 'inventory', to: 'secrets', on: 'success', required: false },
    { id: 'e-inventory-deps', from: 'inventory', to: 'dependencies', on: 'success', required: false },
    { id: 'e-recon-evidence', from: 'recon', to: 'evidence', on: 'success', required: true },
    { id: 'e-sast-evidence', from: 'sast', to: 'evidence', on: 'always', required: false },
    { id: 'e-secrets-evidence', from: 'secrets', to: 'evidence', on: 'always', required: false },
    { id: 'e-deps-evidence', from: 'dependencies', to: 'evidence', on: 'always', required: false },
    { id: 'e-evidence-review', from: 'evidence', to: 'review', on: 'success', required: true },
    { id: 'e-review-decision', from: 'review', to: 'plan-decision', on: 'success', required: true },
    { id: 'e-decision-plan', from: 'plan-decision', to: 'remediation-plan', on: 'success', required: true }
  ]
};

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../addons/workflows/security-review/addon/template.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(definition, null, 2) + '\n');
console.log('wrote', path.relative(process.cwd(), out));
