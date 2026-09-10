---
type: Story
id: FX-BE-093
title: "Provider adapters and capability preflight"
status: planned
feature: FX-BF-035
updated: 2026-09-10
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
