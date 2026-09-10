---
**Status:** 📋 Proposed
type: Feature
id: FX-BF-026
title: "Interactive and agent-assisted runtime debugging"
status: planned
slug: interactive-agent-debugging
stories: [FX-BE-067, FX-BE-068, FX-BE-069, FX-BE-070]
issues: docs/issues/features/fx-bf-026-interactive-agent-debugging/feature-issues.md
updated: 2026-09-07
dependencies: [FX-BF-022]
---

# FX-BF-026: Interactive and agent-assisted runtime debugging

**Priority:** High
**Created:** 2026-09-07

## Outcome

Add a DAP-backed debugger service with a read-only source viewer, Node/TypeScript proof and .NET support, then expose controlled debugging operations to agents.

## Delivery priority

Committed planning scope; implementation remains Planned. Follow the dependency graph and the roadmap's recommended delivery order.

## Dependencies

- FX-BF-022
## Ordered stories

| Order | Ref | Outcome |
| --- | --- | --- |
| 1 | [FX-BE-067](stories/fx-be-067-debugger-contracts-and-adapter-capability-proof/story.md) | Debugger contracts and adapter capability proof |
| 2 | [FX-BE-068](stories/fx-be-068-dap-service-and-node-typescript-debugging/story.md) | DAP service and Node TypeScript debugging |
| 3 | [FX-BE-069](stories/fx-be-069-debug-workspace-and-net-support/story.md) | Debug workspace and .NET support |
| 4 | [FX-BE-070](stories/fx-be-070-controlled-agent-debugging-tools/story.md) | Controlled agent debugging tools |

## Implementation boundaries

Shared domain logic belongs in core; Electron main owns processes, filesystem, credentials and privileged IPC. Renderer imports core types only. Reuse the current workflow engine, Agent Hub and themed in-app dialogs. Project issue backend must not determine deployment executor or target. Files created by the application follow `<name>.praxis.<ext>` with shared filename constants; plan documents retain this repository's established feature/story/task names.

## Close when

Every story and child task is implemented and verified; required integrations have fixture evidence and any real-runtime proof is documented. The feature is a completion roll-up, not a prerequisite for its own children. Planned dependencies are prerequisites to start; containment is recorded through feature/story metadata.

## Verification

Review the complete feature journey and documented support matrix. Follow AGENTS.md for core boundaries, source schema inspection, UI verification and temporary fixtures. Do not claim production support from mocked integration tests alone.
