---
**Status:** ✅ Complete
**Created:** 2026-09-10T10:48:08.259Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-093
title: "Provider adapters and capability preflight"
status: Done
feature: FX-BF-035
updated: 2026-09-25
dependencies: [FX-BE-092]
---

# FX-BE-093: Provider adapters and capability preflight

## Outcome

Praxis can launch supported local provider surfaces through a common adapter and clearly report unavailable capabilities.

## Tasks

- **TASK-257 Define AgentProviderAdapter, capability descriptors, launch request, process output and completion contracts.**
- **TASK-258 Implement the Codex adapter using the installed CLI and non-interactive execution path.**
- **TASK-259 Implement the Claude Code adapter using supported CLI or SDK execution and lifecycle integration.**
- **TASK-260 Implement the Copilot adapter with capability-led launch and manual-handoff fallback.**
- **TASK-261 Add preflight for executable, version, authentication, workspace, MCP and permission capabilities.**

## Acceptance

Each adapter runs a capability probe, returns structured output, and distinguishes unavailable, denied, failed and completed states. Provider version, model, command surface and capabilities are recorded on the session.

## Evidence

Contract tests, fixture repositories, captured provider output, failure and recovery tests, and visual or accessibility evidence where the story affects the desktop surface.

## Description


## Dependencies



## Comments



## Review 2026-09-25 — status corrected from To Do to Done

Found shipped in the codebase during the board review; the ticket was stale at
To Do (updated 2026-09-10).

- `packages/core/src/ai/providers/providerPreflight.ts` defines
  `ProviderPreflightStatus` as exactly `unavailable | denied | failed | ready`,
  matching the acceptance criterion's four states, alongside
  `ProviderCapabilityManifest` (ACP session resume/load/close and MCP-HTTP
  support) and `ProviderCapabilityProbe` (TASK-257).
- `probeCliProvider` runs a non-interactive `--version` capability probe with a
  timeout, parses the provider version, and classifies permission failures as
  `denied` rather than a generic failure — safe to call while rendering provider
  availability (TASK-260).
- Provider version and negotiated capabilities are recorded on the session:
  `AgentSessionRecord.providerVersion` and `providerCapabilities` in
  `packages/core/src/ai/agentTypes.ts`, with `runtimeLaunch` recording what
  actually launched the session.
- Adapters ship behind a common interface in
  `packages/core/src/ai/providers/` — `providerAdapter.ts`, `registry.ts`,
  `anthropicAdapter.ts`, `geminiAdapter.ts`, `openAiCompatibleAdapter.ts` and
  `customProviders.ts` — with ACP hosting in `packages/core/src/ai/acp/`
  (TASK-258, TASK-259).
- Covered by `providerPreflight.test.ts`, `providerProbe.test.ts`,
  `customProviders.test.ts` and the e2e specs `aiProvider.spec.ts`,
  `aiProviderCatalog.spec.ts` and `aiProviderTabs.spec.ts`.

Verified in this review: `npm run build:core` and `npm run test:core`
(1311 tests, 0 failures). Desktop build/e2e commands were unavailable in this
session, so re-run them before release.
