---
type: Feature
id: FX-BF-036
title: "Interactive chat gadgets and response surfaces"
status: planned
updated: 2026-09-10
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
| FX-BE-097 | Versioned gadget and action contracts | Planned | FX-BF-014, FX-BF-015 |
| FX-BE-098 | Renderer registry and core chat surfaces | Planned | FX-BE-097 |
| FX-BE-099 | Safe action lifecycle, scope and stale-state handling | Planned | FX-BE-097, FX-BF-013 |
| FX-BE-100 | Workflow, agent and orchestration integration | Planned | FX-BE-099, FX-BF-035 |
| FX-BE-101 | Accessibility, mobile, fixtures and end-to-end proof | Planned | FX-BE-098, FX-BE-100 |

## Definition of done

A deterministic fixture workflow can ask the user to choose a provider, approve a file change, inspect a table or chart, and resolve a handoff through chat gadgets on desktop and mobile. Actions are validated, persisted and replay-safe; stale and disconnected states are clear; unsupported clients receive readable fallback content; and the complete evidence chain is covered by tests and the plan parser.

## Verification

Use stub agents and fixture repositories. Test contract migration, renderer snapshots, keyboard and screen-reader semantics, narrow mobile layouts, streaming updates, reconnect replay, malformed payloads, stale scope, duplicate submissions and policy-blocked actions. Do not use the repository's own plans as a write-path test target.
