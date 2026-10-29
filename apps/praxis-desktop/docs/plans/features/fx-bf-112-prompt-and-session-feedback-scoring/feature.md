---
**Status:** Done
**Created:** 2026-10-28
**Type:** Feature
**Priority:** High
id: FX-BF-112
type: Feature
status: To Do
priority: High
created: 2026-10-28
updated: 2026-10-28
---

# FX-BF-112: Prompt and session feedback, telemetry analysis, and deterministic scoring

## Outcome

A user can evaluate either a draft/standalone prompt before sending it or any previous AI session (or turn within a session), attach structured human feedback, and receive a reproducible, deterministic `0–100` score broken down across five dimensions — Prompt Clarity, Tool Efficiency, Skill & Agent Alignment, MCP Leverage, and Outcome & Verification Integrity — together with evidence-backed explanations of how the prompt or session should have done better and one-click remediation actions.

## Scope and boundaries

Implement a pure deterministic scoring and signal-extraction engine in `@praxis/core`, profile-local persistence and typed IPC in `@praxis/desktop-main`, and two UI entry points in `@praxis/desktop-renderer` (a pre-send prompt check in the session composer and a post-session feedback & scorecard drawer in the session view/inspector). Optional AI-assisted prompt rewriting may consume the deterministic findings to propose refined prompt wording, but it must never compute or alter the deterministic score. Keep `@praxis/desktop-renderer` imports from `@praxis/core` strictly type-only (`npm run check-core-imports`). No new third-party runtime dependency is required.

## Current implementation evidence

Paths are relative to the monorepo root; inspected 2026-10-28.

| Seam | Observed behavior | Implementation destination |
| --- | --- | --- |
| `packages/core/src/ai/agentTypes.ts` | Defines `AgentSessionRecord`, `AgentEventSummary`, `AgentToolEventData`, `AgentTaskDefinition`, `activeSkills`, `skillActivations`, `detectedSkills` | Add `SessionFeedbackSubmission`, `PromptEvaluationInput`, `DeterministicFeedbackReport`, `FeedbackDimensionScore`, `FeedbackFinding`, and `FeedbackRemediation` contracts |
| `packages/core/src/ai/skillUsage.ts` | Extracts `DetectedSkillUse` (`skill-tool` and `skill-file`) from `tool_start` events | Consumed by the skill-alignment analyzer to compare attached vs self-loaded vs missed trigger-matching skills |
| `packages/core/src/ai/agentRuntime/skillRegistry.ts` and `nativeSources.ts` | Discovers Praxis, bundled, and native AI tool skills/agents with triggers and descriptions | Consumed to identify missed skills or better-suited agent profiles for the prompt and touched files |
| `packages/core/src/ai/mcp/mcpServerConfig.ts` and `mcpToolBridge.ts` | Configures MCP servers and exposes tools as `mcp__<server>__<tool>` alongside built-in `tracker_*`, `browser_*`, and `code_intelligence` tools | Consumed to detect configured vs invoked MCP tools, MCP failures, and shell fallbacks where structured MCP tools existed |
| `packages/core/src/ai/toolEventClassify.ts` and `agentEventUtils.ts` | Classifies tool events (`shell`, `write`, `read`, `list`, `search`, `tracker`, `other`) and file changes | Extended/consumed by the execution-signal analyzer for retry loops, shell-for-search anti-patterns, and unverified writes |
| `apps/praxis-desktop/main/src/main/aiIpc.ts` and `packages/core/src/host/ipcContracts.ts` | Handles `ai:*` IPC channels for sessions | Add `ai:evaluatePrompt`, `ai:evaluateSession`, `ai:submitSessionFeedback`, and `ai:rewritePromptFromFeedback` |
| `apps/praxis-desktop/renderer/src/ai/SessionsPage.tsx`, `NewSession.tsx`, and `SessionInspector.tsx` | Composer controls (`toolMode`, model, agent, skills) and session inspector tabs | Add composer "Score Prompt" popover and session inspector/turn "Feedback & Score" panel |

## Deterministic scoring model (`SCORING_RUBRIC_VERSION = 1`)

The scoring engine is a pure function `evaluateSessionOrPrompt(input: FeedbackEvaluationInput): DeterministicFeedbackReport` in `packages/core/src/ai/feedback/sessionFeedbackScorer.ts`. Given identical inputs, it always produces the exact same overall score (`0–100`), dimension sub-scores, findings, and remediation items.

| Dimension | Max points | Deterministic signals evaluated | How it should have done better (remediation output) |
| --- | --- | --- | --- |
| 1. Prompt Clarity & Context Readiness | 20 | Goal length/specificity, presence of concrete file/symbol/ticket anchors, explicit verification/acceptance expectations, absence of contradiction between prompt intent (e.g. "implement/edit") and `toolMode` (`read-only`), and context window headroom (`contextTokens / contextLimit < 0.85`) | Suggests adding explicit file/ticket references, stating a verification command, switching `toolMode`, or compacting/starting a fresh session |
| 2. Tool & Execution Efficiency | 25 | Ratio of successful tool calls (`data.ok !== false`), absence of consecutive identical or near-identical failed retries, read/search-to-edit churn ratio, absence of permission-denial loops (`permission_requested` denied repeatedly), and step budget efficiency (`stepCount / maxSteps`) | Identifies the exact looping/failing tool calls and recommends targeted tool calls or adjusting `permissionMode` |
| 3. Skill & Agent Alignment | 20 | Whether attached skills (`activeSkills`) were relevant, whether skills matching prompt keywords or touched file paths (e.g. `plan-authoring` for `docs/plans/**`, `praxis-addon-builder` for add-ons) were attached or loaded (`detectedSkills`), and whether the selected Agent Hub profile (`profileId`) matches the session's `mode` (`chat`, `analysis`, `review`) | Names specific missed skills to attach (`activeSkills`) or a better-suited Agent Hub profile (`praxis-planner`, `praxis-implementer`, `praxis-reviewer`) |
| 4. MCP & Structured Capability Leverage | 15 | Detection of raw `shell` workarounds (`grep`, `find`, `cat`, `curl`, manual git/tracker CLI) when structured tools or MCP servers (`code_intelligence`, `tracker_*`, `browser_*`, `mcp__<server>__*`) were available for the session, plus MCP call error/timeout rate | Recommends the exact MCP tool or server (e.g. `code_intelligence` `find_symbol` / `search_code` or `tracker_transition_ticket`) that replaces the shell workaround |
| 5. Outcome & Verification Integrity | 20 | Terminal session state (`completed` vs `failed`/`aborted`), presence of a verification step (test/typecheck/build command) *after* the last file write (`isLatestEditToPath`), absence of user edit-undo actions, and alignment with explicit user feedback (`helpful`, `needs-work`, `failed-goal` and friction tags) | Recommends running verification after the final edit, addressing user-flagged friction tags, or splitting oversized changesets |

For **pre-send prompt evaluation** (where no execution events exist yet), the scorer evaluates Dimension 1 (Prompt Clarity & Context Readiness), Dimension 3 (pre-launch Skill & Agent Alignment against prompt triggers), and Dimension 4 (MCP & Capability Readiness for the prompt's domain), normalizing the pre-execution readiness score to `0–100` while clearly labeling it as a **Prompt Readiness Score** (`kind: 'prompt-readiness'`) distinct from a **Session Execution Score** (`kind: 'session-execution'`).

## Concrete data model

Store feedback submissions and computed reports in a versioned profile-local store (`session-feedback.json`) keyed by `sessionId` (and optional `turnIndex`) or standalone `promptEvaluationId`, plus embed the latest summary badge on `AgentSessionRecord.feedbackSummary` so session lists and inspectors render scores without extra IPC round-trips.

| Entity | Required fields and invariants |
| --- | --- |
| `UserFeedbackInput` | `targetKind: 'prompt' \| 'session' \| 'turn'`, `sessionId?`, `issueKey?`, `turnIndex?`, `promptText`, `verdict?: 'helpful' \| 'needs-work' \| 'failed-goal'`, `frictionTags?: FeedbackFrictionTag[]`, `notes?: string`, `createdAt: string` |
| `FeedbackDimensionScore` | `dimension: 'prompt-clarity' \| 'tool-efficiency' \| 'skill-agent-alignment' \| 'mcp-leverage' \| 'outcome-verification'`, `earnedPoints: number`, `maxPoints: number`, `normalizedScore: number`, `summary: string` |
| `FeedbackFinding` | `id: string`, `dimension: FeedbackDimensionId`, `severity: 'info' \| 'warning' \| 'critical'`, `deltaPoints: number`, `title: string`, `evidence: string`, `remediation: FeedbackRemediation` |
| `FeedbackRemediation` | `kind: 'attach-skill' \| 'select-agent' \| 'enable-mcp' \| 'change-tool-mode' \| 'refine-prompt' \| 'add-verification' \| 'avoid-tool-pattern'`, `label: string`, `description: string`, `targetId?: string`, `suggestedPromptSnippet?: string` |
| `DeterministicFeedbackReport` | `schemaVersion: 1`, `rubricVersion: 1`, `reportId: string`, `evaluatedAt: string`, `kind: 'prompt-readiness' \| 'session-execution'`, `inputDigest: string`, `overallScore: number`, `grade: 'A' \| 'B' \| 'C' \| 'D' \| 'F'`, `dimensions: FeedbackDimensionScore[]`, `findings: FeedbackFinding[]`, `inventory: { promptsAnalyzed: number; toolsUsed: string[]; mcpToolsUsed: string[]; mcpServersConfigured: string[]; agentProfileId?: string; skillsAttached: string[]; skillsDetected: string[]; skillsRecommended: string[] }`, `userFeedback?: UserFeedbackInput`, `aiRewrite?: { rewrittenPrompt: string; rationale: string; modelId?: string }` |

## Feature acceptance criteria

- AC1: Evaluating the same prompt or `AgentSessionRecord` snapshot with the same catalog and user feedback twice produces byte-identical scores, dimension breakdowns, findings, and `inputDigest` values (`SCORING_RUBRIC_VERSION = 1`).
- AC2: Pre-send prompt evaluation detects vague goals, missing file/ticket scope, missing verification expectations, `read-only` tool-mode contradictions on edit prompts, and unattached trigger-matching skills, returning a `prompt-readiness` score (`0–100`) and actionable remediations.
- AC3: Session execution evaluation inventories every prompt turn, tool call (`AgentToolEventData`), agent profile (`profileId`), skill (`activeSkills` + `detectedSkills`), and MCP tool (`mcp__*`, `tracker_*`, `browser_*`, `code_intelligence`), deducting deterministic points for failed tool loops, shell-for-search workarounds when structured tools exist, missed trigger-matched skills, and unverified file writes.
- AC4: User feedback (`verdict`, `frictionTags`, `notes`) can be submitted for any previous session, specific turn, or standalone prompt, persists across app restarts in `session-feedback.json`, and deterministically adjusts the Outcome & Verification dimension and remediation priorities.
- AC5: From the session composer (`NewSession` and `SessionsPage`), a user can score their draft prompt, apply one-click remediations (attach a recommended skill, switch agent profile or tool mode, or insert verification criteria), and optionally request an AI-assisted prompt rewrite grounded in the deterministic findings.
- AC6: From `SessionInspector` and completed transcript turns, a user can open the Feedback & Score scorecard, inspect the 5-dimension breakdown and tool/skill/MCP audit table, submit feedback, and launch a follow-up or re-run with recommended skills/agent/prompt improvements applied.

## Validation and release gates

Commands below run from the monorepo root during implementation:

```sh
npm run build:core
npm run test:core
npm run check-types
npm run build:renderer
npm run desktop:copy-renderer
npm run build:desktop
npm run test:e2e --workspace=@praxis/desktop-main -- sessionFeedback.spec.ts --project=functional
npm run test:desktop:smoke
```

## Close when

All four stories (`FX-BE-185` through `FX-BE-188`) and eight tasks (`TASK-488` through `TASK-495`) meet their acceptance criteria, deterministic golden-corpus unit tests and Playwright E2E tests pass, and visual verification artifacts are captured.

## Story map

| ID | Story | Depends on |
| --- | --- | --- |
| [FX-BE-185](stories/fx-be-185-deterministic-scoring-engine/story.md) | Deterministic prompt, tool, skill, agent, and MCP evaluation engine | None |
| [FX-BE-186](stories/fx-be-186-feedback-persistence-and-ipc/story.md) | Feedback persistence, IPC commands, and optional AI prompt rewrite | FX-BE-185 |
| [FX-BE-187](stories/fx-be-187-composer-and-session-feedback-ui/story.md) | Composer prompt check and session feedback scorecard UI | FX-BE-186 |
| [FX-BE-188](stories/fx-be-188-feedback-scoring-verification/story.md) | End-to-end verification and deterministic scoring corpus proof | FX-BE-187 |

## Dependencies

None

## Description

Provides deterministic scoring (`0–100`) and actionable retrospective/pre-send feedback for prompts and AI sessions by analyzing prompt quality, tool call efficiency, Agent Hub profile selection, attached vs detected vs missed skills, and MCP server utilization.

## Rubric v2 — workspace-grounded coach and root-cause scorecard

`SCORING_RUBRIC_VERSION = 2`. Reports scored under v1 are re-evaluated on read.

- **Intent first.** Prompts are classified (`question`, `follow-up`, `bugfix`, `feature`, `plan`, `review`) before grading; questions and plans are never charged for a missing file anchor or test command.
- **Follow-up context.** A follow-up turn inherits the running session's touched files and ticket (`derivePriorContext`), so "commit all changes" scores as ready instead of terse.
- **Workspace grounding.** The host gathers git-changed files, test files, and npm scripts (`feedbackWorkspaceHints.ts`); core ranks them against the prompt (`workspaceGrounding.ts`) so fixes pin a real file or name a real test command — no boilerplate is pasted into the prompt.
- **Checked against the code.** Prompt words are matched against every tracked file and folder name (with one-edit spelling suggestions), and identifiers the prompt names are looked up by exact name in the folder's code index — read-only, no registration or grant. A found symbol anchors the prompt; an unknown one is flagged unless the prompt introduces it ("rename X to Y"). Code intelligence counts as available only where a session would actually get it.
- **Root causes, not counts.** Session findings name blind-edit loops, edits made without reading, thrashing on one file, unresolved test failures, and serial read sprawl, each citing the transcript steps (`FeedbackStepRef`) the scorecard can jump to.
- **UI.** The composer coach waits for a 1.2s typing pause (immediate for the read-only blocker), offers one-click workspace fix chips with a hover/focus preview, and steps aside with a "Context ready" note on follow-ups. The scorecard leads with a diagnosis and an auto-saving verdict, merges capability facts into the five dimension rows, and stages concrete fixes into the follow-up.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-185 | Story | Deterministic prompt, tool, skill, agent, and MCP evaluation engine | To Do |
| FX-BE-186 | Story | Feedback persistence, IPC commands, and optional AI prompt rewrite | To Do |
| FX-BE-187 | Story | Composer prompt check and session feedback scorecard UI | To Do |
| FX-BE-188 | Story | End-to-end verification and deterministic scoring corpus proof | To Do |

## Comments
