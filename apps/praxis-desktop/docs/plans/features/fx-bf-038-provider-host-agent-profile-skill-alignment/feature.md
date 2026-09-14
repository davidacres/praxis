---
**Status:** 🚧 In progress
**Created:** 2026-09-14
**Type:** Feature
**Priority:** Critical
id: FX-BF-038
slug: provider-host-agent-profile-skill-alignment
title: "Separate providers, runtime hosts, agent profiles and skills"
status: In Progress
updated: 2026-09-14
dependencies: [FX-BF-009, FX-BF-010, FX-BF-011, FX-BF-013, FX-BF-035]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# FX-BF-038: Separate providers, runtime hosts, agent profiles and skills

## Outcome

Praxis has a provider-neutral execution model in which an AI provider, runtime host, agent profile, skill and session are separate concepts. Existing ACP, gateway and local-tool sessions continue to work while provider-specific capabilities are negotiated explicitly.

## Problem

The current implementation uses “agent” for multiple things:

- AgentManifest describes an executable runtime host.
- AgentHost is the running process or adapter.
- Bundled agent briefs describe role instructions.
- SKILL.md files describe reusable procedures.
- Providers identify the model/service.
- Sessions perform the actual work.

This makes it unclear whether a workflow is selecting a role, a process, a model, or a set of instructions. It also makes native skills appear supported when Praxis may only be injecting their text as context.

## Canonical model

| Concept | Responsibility |
| --- | --- |
| Provider | Model/service identity, model selection and provider API |
| Runtime host | ACP process, SDK, HTTP endpoint or local tool-loop adapter |
| Agent profile | Provider-neutral role, instructions, constraints and preferred capabilities |
| Skill | Reusable instructions, tools, inputs and outputs |
| Binding | Selection of profile, host/provider and skills for one session |
| Session | One execution with state, events, permissions and artefacts |
| Workflow | Composition and governance of sessions, skills, checks and approvals |

## Scope

- Add canonical AgentProfile, AgentHostManifest, AgentBinding and skill activation contracts.
- Rename and migrate host-facing terminology without breaking persisted records or add-ons.
- Keep backwards-compatible reads for existing AgentManifest files.
- Separate provider selection from host selection.
- Implement capability negotiation with explicit native, tools and context fallbacks.
- Make skill activation truthful: native activation is only reported when the host confirms it; otherwise Praxis records the selected fallback.
- Compile a provider-neutral binding into provider-specific launch/context instructions.
- Persist profile, host, provider, skill versions and activation modes on sessions.
- Update workflow preflight, stage dispatch and Agent Hub UI to display the distinct concepts.
- Add migration diagnostics for ambiguous legacy agent manifests.
- Add deterministic stub-host tests and provider-specific adapter fixtures.

## Non-goals

- Reimplementing Claude, Codex, Copilot or another provider.
- Assuming all providers support native agents or native skills.
- Replacing provider-native functionality.
- Sharing private provider conversation history.
- Allowing multiple mutating sessions to use one worktree.

## Delivery order

| Ref | Work | Depends on | Status |
| --- | --- | --- | --- |
| FX-BE-115 | Canonical contracts and terminology | — | In progress |
| FX-BE-116 | Legacy manifest/profile migration | FX-BE-115 | Planned |
| FX-BE-117 | Provider/host adapter binding | FX-BE-115 | Planned |
| FX-BE-118 | Skill activation and fallback execution | FX-BE-117 | Planned |
| FX-BE-119 | Workflow and session persistence migration | FX-BE-116, FX-BE-117 | Planned |
| FX-BE-120 | Agent Hub and composer UX | FX-BE-119 | Planned |
| FX-BE-121 | End-to-end compatibility and documentation | FX-BE-118, FX-BE-120 | Planned |

## Definition of done

A single Praxis agent profile can be selected with any compatible provider and host. The same workflow can run through ACP, gateway and local-tool execution. Praxis shows the selected profile, provider, host, skills and activation modes separately; no provider is claimed to support a native skill unless it confirms that capability; old manifests remain readable and receive migration guidance; focused and desktop tests pass.

## Initial implementation

packages/core/src/ai/agentContracts.ts introduces the canonical vocabulary and a pure activation planner. Existing runtime code is intentionally not renamed in this first slice; subsequent stories migrate it behind these contracts.

## Verification

Run core type checking and tests, then desktop type checking and tests. Include cases for native skill support, tool fallback, context fallback, missing capabilities, legacy manifests and persisted-session compatibility.
