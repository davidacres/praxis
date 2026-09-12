# Praxis SDLC quality and security gates roadmap

Status: Planned; implementation has not started.
Prepared: 2026-09-09.
Source baseline: 50fa4e7.

## Why this exists

Praxis already runs a governed delivery workflow — a validated DAG where agents
implement, deterministic checks verify, and a human approves against an
immutable implementation snapshot, with strictest-wins policy composition and an
audited bypass. What it does **not** yet have is a quality and security bar that
stands next to CodeRabbit, SonarQube or Aikido:

- The built-in `governed-delivery` template is npm/JavaScript-only. QA is
  `npm test`; security is `npm audit --audit-level=high`. Both are pass/fail
  exit codes.
- The `review` gate is an opaque agent (`praxis-reviewer`) that produces a
  free-text `report`. The engine guarantees the stage ran and returned the
  artifact it promised; it cannot see severity, cannot post line-level comments,
  and cannot re-drive implementation to clear a blocking finding.
- Check nodes understand exit codes only. There is no SARIF / JUnit / lcov
  parsing, so a gate cannot rest on "coverage on new code ≥ 80 %" or "zero new
  high-severity findings".
- No agents ship with the app. `praxis-planner` / `praxis-implementer` /
  `praxis-reviewer` are id conventions a project must satisfy itself.
- `aiReviewService.ts` has real code-review and security-review prompts (OWASP
  Top 10, authz, secrets, supply chain) but they run only as ticket-context
  panels, never as workflow gate stages.

This roadmap adds structured findings, a real security gate, a review that
behaves like a reviewer, out-of-the-box agents and templates, and CI-report
ingestion — reusing the existing workflow engine, gate model, evidence store
and policy composition rather than building a second pipeline.

## Agreed product decisions

- Extend the current workflow engine, gate kinds and policy composition. Do not
  add a parallel quality pipeline or a second results store.
- A gate is still satisfied by a node outcome, never by agent prose. New
  threshold gates are evaluated by the engine from parsed metrics/findings, the
  same standing as an exit code.
- Structured results are a new closed artifact kind (`findings`) with a stable
  shape: `findings[]` (fingerprint, file, line, severity, category, message,
  optional suggestion) and `metrics{}` (named numbers). Adapters normalise tool
  output into it; nothing downstream parses raw tool formats.
- The three gate kinds stay `review` / `qa` / `security`. A gate may now be
  backed by more than one node: its owning join converges several checks, and
  policy states the threshold the union must meet.
- Scanners are bundled **check presets**, not connection modes and not
  catalogue data — they are code, chosen by detected stack, emitting SARIF into
  `findings`. A project enables or disables each; policy sets the severity bar.
- Suppression is an audited, expiring waiver register keyed by finding
  fingerprint, composed strictest-wins with the org exactly like gate bypass.
  A waiver is recorded on the run event log with who, when and why.
- The reviewer agent must emit a `findings` artifact; free-text summary is
  allowed alongside but is not the gate evidence. Inline delivery to a PR or
  ticket dedupes against prior runs by fingerprint.
- Bundled agents install **trusted** because they ship in the app image and run
  through the existing ACP host; a project still points the template's agent
  ids at them explicitly.
- CI-report ingestion is read-only and "observe" mode: imported GitHub code
  scanning / Dependabot / GitLab SAST / dependency-scanning results become
  `findings` evidence a gate can rest on, mirroring the deployment observe
  pattern. Nothing here dispatches or re-runs a CI job.

## Existing implementation to extend

`packages/core/src/workflows` — `workflowTypes.ts` (artifact kinds, gate kinds,
node types), `workflowGates.ts` (gate evaluation, approval, bypass),
`workflowTemplates.ts` (built-ins), `workflowValidation.ts`, `workflowRun.ts`.
`apps/praxis-desktop/main/src/main/workflowCheckRunner.ts` already captures check
output through the redacting evidence store — adapters attach there. The
evidence bundle format and `redactEvidenceContent` from FX-BE-051 are reused for
both scanner output and imported CI logs. `aiReviewService.ts`'s
`CODE_REVIEW_SYSTEM_PROMPT` / `SECURITY_REVIEW_SYSTEM_PROMPT` become the basis
of the bundled reviewer/security-analyst agent briefs. FX-BE-053's read-only CI
providers are extended, not duplicated, for report ingestion.

Application-written configuration uses the shared `<name>.praxis.<ext>` naming
constants. Bundled agent manifests live in the app image and are mirrored into
the trusted discovery root on first run, not written into a user's project.

## Feature and story breakdown

| Ref | Outcome |
| --- | --- |
| [FX-BF-034](/apps/praxis-desktop/docs/plans/features/fx-bf-034-sdlc-quality-and-security-gates/feature.md) | Full SDLC quality and security gates |
| FX-BE-087 | Structured check results and metric/severity threshold gates |
| FX-BE-088 | Bundled secret / SAST / SCA / license scanners behind the security gate |
| FX-BE-089 | Structured code review with inline delivery and a bounded fix loop |
| FX-BE-090 | Bundled trusted agents and a language-agnostic Full SDLC template |
| FX-BE-091 | Ingest CI security and quality reports as observe-mode gate evidence |

### FX-BE-087 — Structured check results and threshold gates (foundation)

- **TASK-237** Define the `CheckFindings` contract and the `findings` artifact
  kind. Fingerprint is stable across runs for the same underlying issue.
- **TASK-238** Result-format adapters: SARIF 2.1.0, JUnit XML, lcov / Cobertura,
  `npm audit --json`, `osv-scanner` JSON. Each maps to `CheckFindings`; an
  unrecognised or malformed report fails the node with a stated reason rather
  than passing empty.
- **TASK-239** Metric- and severity-threshold gate policy: a gate condition of
  the form `metrics.<name> >= n` or `findings(severity >= <level>).count == 0`,
  evaluated by the engine, composed strictest-wins so a project can tighten but
  never loosen the org bar.
- **TASK-240** Render findings and metrics in the run monitor — grouped by
  severity, each linking to its file/line and its evidence entry.

### FX-BE-088 — Bundled security scanners

- **TASK-241** Check presets for secret scanning (gitleaks), SAST (semgrep with
  a curated ruleset), SCA (osv-scanner / Trivy filesystem) and license policy.
  Language/manifest detection picks the default set; each preset emits SARIF and
  is a normal `check` node the designer can add, remove or re-point.
- **TASK-242** Audited waiver register: a project-scoped, strictest-wins list of
  `{ fingerprint, reason, actor, expiresAt }` that suppresses a matching finding
  from gate evaluation. Expiry is enforced; a lapsed waiver re-blocks. Every
  add/remove is on the run event log.
- **TASK-243** Compose the `security` gate over the union of enabled scanners
  plus the policy threshold, so "security passed" means every enabled scanner
  ran and the combined un-waived findings are under the bar — not that one
  command exited zero.

### FX-BE-089 — Structured code review

- **TASK-244** Structured reviewer artifact contract: the reviewer stage must
  return `findings` (file, line, severity, category, optional suggested patch),
  validated like any artifact. Summary prose is optional and non-authoritative.
- **TASK-245** Inline review delivery: post findings as review comments on the
  GitHub / GitLab PR when the project has one, else as a structured ticket
  comment; dedupe against the previous run's fingerprints so a re-review only
  adds what changed.
- **TASK-246** Bounded review→implement fix loop: on findings at or above a
  configured blocking severity, route back to a re-implement stage within an
  attempt budget, then re-review, before the gate can pass.

### FX-BE-090 — Bundled agents and Full SDLC template

- **TASK-247** Ship bundled trusted agent manifests — `praxis-planner`,
  `praxis-implementer`, `praxis-reviewer`, `praxis-security-analyst` — mirrored
  into the trusted discovery root on first run, briefs derived from
  `aiReviewService.ts`'s existing review prompts.
- **TASK-248** Add the `full-sdlc` built-in template:
  `Plan → Implement → (Lint ∥ Type-check ∥ Unit tests + coverage ∥ SAST ∥
  Secrets ∥ SCA ∥ AI review) → Gates(qa, security, review) → Approve`, with an
  optional trailing `Deploy` node. Check commands resolve from detected stack.
- **TASK-249** Per-stack template variants (Node, .NET, Python): identical DAG,
  detected commands. The repo's `csharp-dotnet-code-reviewer` agent and
  `dotnet-solid-dry` skill are the .NET review inputs.

### FX-BE-091 — CI report ingestion

- **TASK-250** Read-only providers for GitHub code scanning + Dependabot alerts
  and GitLab SAST + dependency-scanning report artifacts, extending FX-BE-053's
  CI evidence providers. Token scope stays read-only.
- **TASK-251** Map imported reports to `findings` in the evidence store, bound
  to the exact source SHA, so an imported result is the same shape as a locally
  run scanner's.
- **TASK-252** Observe-mode gate: a `security` or `qa` gate may rest on imported
  CI evidence for the run's snapshot instead of a local check, reconciled the
  way an observed deployment is — if CI already ran the scan, Praxis reads it
  rather than running it again.

## Recommended delivery order and completion gates

| Priority | Story | Task range | Completion gate |
| --- | --- | --- | --- |
| 1 | FX-BE-087 | TASK-237–240 | A check node's SARIF/JUnit/lcov output drives a metric-threshold gate; the run monitor shows findings by severity. |
| 2 | FX-BE-088 | TASK-241–243 | Secret, SAST and SCA presets run on a fixture repo; a seeded high-severity finding blocks approval; an expiring waiver clears it and is on the event log. |
| 3 | FX-BE-089 | TASK-244–246 | A reviewer returns structured findings; blocking findings post inline and re-drive implementation within budget; a clean re-review passes the gate. |
| 4 | FX-BE-090 | TASK-247–249 | A fresh install runs `full-sdlc` end to end with bundled agents and no manual agent setup, on a Node and a .NET fixture. |
| 5 | FX-BE-091 | TASK-250–252 | An imported GitHub code-scanning result satisfies a security gate for the matching SHA without a second local scan. |

## Hard dependencies

- FX-BE-087 depends on FX-BE-020 (gates, artifacts, approvals) and FX-BE-024
  (deterministic check execution). It is the foundation for every other story.
- FX-BE-088 depends on FX-BE-087.
- FX-BE-089 depends on FX-BE-087 and FX-BE-033 (review and correction controls).
- FX-BE-090 depends on FX-BE-088, FX-BE-089 and FX-BE-011 (agent runtime and
  trust).
- FX-BE-091 depends on FX-BE-087 and FX-BE-053 (read-only CI evidence import).
- Within each story, tasks are sequential unless their Dependencies section says
  otherwise. Feature containment is a completion roll-up, not a start
  dependency.

This is an ordering plan, not a calendar estimate. Scanner adapter behaviour,
SARIF fidelity and provider report shapes must be proven by their assigned
tasks against real tool output before scope expands.

## Cross-cutting acceptance requirements

- A gate's outcome is always engine-decided. A threshold gate reads parsed
  metrics/findings; it never trusts an agent's claim about coverage or
  vulnerability count.
- Scanner and imported-report content is redacted before it becomes evidence or
  reaches a model, reusing `redactEvidenceContent`.
- Every finding, waiver and review comment binds project, source snapshot and
  attempt. A changed snapshot invalidates a waiver match and a prior review's
  dedupe set.
- Policy composition stays strictest-wins. A project may add scanners, raise a
  threshold or shorten a waiver's life; it may never drop a gate or lower a bar
  the org set.
- A waiver and a gate bypass are distinct: a waiver suppresses one known finding
  with an expiry; a bypass overrides a whole failing gate once. Both are
  audited; neither is silent.
- Bundled agents install trusted because they ship in the image; a project still
  references them by id. Nothing downloaded from the marketplace gains trust
  this way.
- New surfaces reuse theme tokens, pane conventions, dialogs, keyboard focus and
  command-palette navigation. No runtime core imports into renderer code.

## Verification and definition of done

Each task carries a concrete acceptance scenario and a completion-evidence
section. Adapters are tested against captured real output from each tool
(checked-in fixture files), not hand-written approximations. Scanner presets run
in CI against a deliberately vulnerable fixture repo; live scans on a real
project stay opt-in. UI changes rebuild and copy the renderer before focused
Electron specs, then inspect captures across theme axes, narrow layouts and
keyboard focus. Regression guards are proven to fail against the pre-change
behaviour. No test points a Praxis write path at this repository's own plans.

For any planning change, run the repository's read-only `parsePlanFolder` over
baseline and final plans: all new IDs unique, all new files typed/titled/status
as expected, dependency tokens surviving parsing, dependency targets resolving,
the prerequisite graph acyclic, and local links resolving. Do not invoke
`FolderService` write paths against these plans.

## Research provenance

Design precedents reviewed 2026-09-09, not guaranteed capabilities of a CLI
hosted through ACP:

- [SARIF 2.1.0 specification](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html)
- [GitHub code scanning API](https://docs.github.com/en/rest/code-scanning)
- [GitLab SAST and dependency scanning reports](https://docs.gitlab.com/ee/user/application_security/)
- [OSV-Scanner](https://google.github.io/osv-scanner/)
- [Semgrep CI / rulesets](https://semgrep.dev/docs/)
- [Gitleaks](https://github.com/gitleaks/gitleaks)
- [SonarQube quality gates](https://docs.sonarsource.com/sonarqube/latest/user-guide/quality-gates/)

Before implementation, inspect the installed ACP schema and each tool's current
output format. Record chosen tool versions and the SARIF fields relied on.
