---
**Status:** 🚧 In progress
**Created:** 2026-09-10T10:48:08.192Z
**Type:** Feature
**Priority:** Medium
type: Feature
id: FX-BF-036
title: "Interactive chat gadgets and response surfaces"
status: In Progress
updated: 2026-09-13
dependencies: [FX-BF-014, FX-BF-015, FX-BF-035]
---

# FX-BF-036: Interactive chat gadgets and response surfaces

## Outcome

Praxis can render safe, typed interactive gadgets inside chat so users can make decisions, inspect evidence and approve or control work without translating structured results into free-text commands.

## Scope

- Versioned browser-safe ChatBlock, GadgetEnvelope and GadgetAction contracts.
- Gadget request validation, capability policy and plain-text fallback.
- Renderer registry with desktop and mobile responsive implementations.
- Choice, confirmation, table, chart, progress, diff and context/handoff surfaces.
- Command-ledger integration, idempotency, correlation and audit evidence.
- Session/project/work scoping, stale and expiry handling, reconnect replay and streaming updates.
- Workflow gates, provider selection, handoffs, conflict resolution and review integration.
- Accessibility, visual, fixture, contract and end-to-end verification.

## Non-goals

- Arbitrary model-supplied executable UI or embedded JavaScript.
- Replacing the existing chat, workflow, run monitor or diff workspace.
- Allowing a gadget to bypass workflow policy, approval gates or host authorization.
- Provider-specific UI contracts.
- Cloud-only operation or a dependency on GenericSystem, Roleover, Azure, VPN/Tailscale or push notifications.
- Treating natural-language inference as authoritative for destructive or approval-required actions.

## Stories

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-097 | Versioned gadget and action contracts | Done | FX-BF-014, FX-BF-015 |
| FX-BE-098 | Renderer registry and core chat surfaces | Done | FX-BE-097 |
| FX-BE-099 | Safe action lifecycle, scope and stale-state handling | Done | FX-BE-097, FX-BF-013 |
| FX-BE-100 | Workflow, agent and orchestration integration | In progress | FX-BE-099, FX-BF-035 |
| FX-BE-101 | Accessibility, mobile, fixtures and end-to-end proof | In progress | FX-BE-098, FX-BE-100 |

## Delivery note (2026-09-13)

The contract, renderer and safety spine are complete and exercised end to end on
desktop: a provider asks for a gadget in its own message, Praxis parses it,
stamps scope, validates, renders one of eleven surfaces, and records the answer
through an idempotent ledger with evidence. See
[docs/interactive-chat-gadgets.md](../../../../../../docs/interactive-chat-gadgets.md).

Outstanding, and why:

- **TASK-285** (stage/session *expected response* declarations) — needs the
  workflow orchestrator to pause and resume on a declared response, which is a
  change to run state, not to the gadget contract.
- **TASK-287** (run monitor, changes and deployment decisions) — the executor
  deliberately only records decisions today. Wiring a gadget action to actually
  advance a run or deploy means calling through the services that own those
  gates, and is the next increment.
- **TASK-290** (mobile half) — the contract is browser-safe and the renderers
  are responsive, with a narrow-viewport rule set and touch-target floors, but
  `apps/praxis-mobile` has no gadget host yet, so the mobile journey is unproven.

## Definition of done

A deterministic fixture workflow can ask the user to choose a provider, approve a file change, inspect a table or chart, and resolve a handoff through chat gadgets on desktop and mobile. Actions are validated, persisted and replay-safe; stale and disconnected states are clear; unsupported clients receive readable fallback content; and the complete evidence chain is covered by tests and the plan parser.

## Verification

Use stub agents and fixture repositories. Test contract migration, renderer snapshots, keyboard and screen-reader semantics, narrow mobile layouts, streaming updates, reconnect replay, malformed payloads, stale scope, duplicate submissions and policy-blocked actions. Do not use the repository's own plans as a write-path test target.

## Description


## Dependencies



## Comments




**PRAXIS-F36** — 2026-09-20T19:26:57.509Z
**Workflow run failed: Governed delivery — FX-BF-036: Interactive chat gadgets and response surfaces**

Status: Failed · Duration: 9m 10s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Review: running
- ⏳ QA: running
- ❌ Security scan: failed

Required stage "security" failed.

**PRAXIS-F36** — 2026-09-20T20:42:39.546Z
**Workflow run failed: Governed delivery — FX-BF-036: Interactive chat gadgets and response surfaces**

Status: Failed · Duration: 9m 53s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ⏳ Review: running
- ❌ QA: failed
- ✅ Security scan: succeeded

Required stage "qa" failed.

**PRAXIS-F36** — 2026-09-20T21:24:05.113Z
**Workflow run failed: Governed delivery — FX-BF-036: Interactive chat gadgets and response surfaces**

Status: Failed · Duration: 11m 50s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ❌ QA: failed
- ✅ Security scan: succeeded

Required stage "qa" failed.

**PRAXIS-F36** — 2026-09-20T21:49:17.692Z
**Workflow run failed: Governed delivery — FX-BF-036: Interactive chat gadgets and response surfaces**

Status: Failed · Duration: 23m 31s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ❌ QA: failed
- ✅ Security scan: succeeded

Required stage "qa" failed.

**PRAXIS-F36** — 2026-09-20T22:03:04.883Z
**Workflow run cancelled: Governed delivery — FX-BF-036: Interactive chat gadgets and response surfaces**

Status: Cancelled · Duration: 13m 14s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ⏭️ QA: cancelled
- ✅ Security scan: succeeded

cancelled from the run view

**PRAXIS-F36** — 2026-09-20T22:28:59.754Z
**Workflow run failed: Governed delivery — FX-BF-036: Interactive chat gadgets and response surfaces**

Status: Failed · Duration: 12m 36s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ❌ QA: failed
- ✅ Security scan: succeeded

Required stage "qa" failed.