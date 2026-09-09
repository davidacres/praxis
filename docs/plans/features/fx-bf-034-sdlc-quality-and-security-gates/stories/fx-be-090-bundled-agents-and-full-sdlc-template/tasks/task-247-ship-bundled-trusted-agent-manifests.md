---
type: Task
id: TASK-247
title: "Ship bundled trusted agent manifests"
status: planned
story: FX-BE-090
updated: 2026-09-09
dependencies: [FX-BE-011]
---

# TASK-247: Ship bundled trusted agent manifests

**Priority:** Medium
**Created:** 2026-09-09

## Goal

Ship four agent manifests in the app image — `praxis-planner`, `praxis-implementer`, `praxis-reviewer`, `praxis-security-analyst` — each an `agent.json` plus a brief. Reviewer and security-analyst briefs are built from `aiReviewService.ts`'s `CODE_REVIEW_SYSTEM_PROMPT` / `SECURITY_REVIEW_SYSTEM_PROMPT`, plus the FX-BE-089 structured-findings output rule. On first run, mirror them into the trusted discovery root (the same root the marketplace uses once trust is granted), marked trusted because they ship in the image. They are never written into a user's project folder.

## Implementation entry points

packages/core/src/ai/agentRuntime/discovery.ts (a bundled-manifests source ahead of the user root), the first-run mirror step in the agent runtime instance (apps/praxis-desktop/main/src/main/agentRuntimeInstance.ts), app image assets for the four manifest folders.

## Dependencies

- FX-BE-011
## Acceptance criteria

- On a fresh profile, the four agents are discovered, `trusted: true`, and startable through the existing ACP host with no user action.
- The mirror target is the trusted discovery root only; no manifest lands in any project folder; re-running first-run is idempotent.
- A user-supplied agent with the same id as a bundled one still wins from the user root (bundled is the fallback), matching the existing discovery precedence.
- The implementation satisfies the parent story's outcome and preserves existing unrelated agent discovery.

## Verification

Core tests for bundled discovery, trust and precedence; a first-run mirror test asserting idempotency and the target path. `npm run test:core`, `npm run test:desktop`, `npm run check-types`. Live-agent start stays opt-in. Never point a Praxis write path at the repository's own plans.
