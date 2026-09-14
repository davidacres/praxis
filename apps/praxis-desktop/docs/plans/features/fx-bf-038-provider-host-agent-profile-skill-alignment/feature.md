---
**Status:** ✅ Complete
**Created:** 2026-09-14
**Type:** Feature
**Priority:** Critical
id: FX-BF-038
slug: provider-host-agent-profile-skill-alignment
title: "Separate providers, runtime hosts, agent profiles and skills"
status: Complete
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
| FX-BE-115 | Canonical contracts and terminology | — | Implemented |
| FX-BE-116 | Legacy manifest/profile migration | FX-BE-115 | Implemented |
| FX-BE-117 | Provider/host adapter binding | FX-BE-115 | Implemented |
| FX-BE-118 | Skill activation and fallback execution | FX-BE-117 | Implemented |
| FX-BE-119 | Workflow and session persistence migration | FX-BE-116, FX-BE-117 | Implemented |
| FX-BE-120 | Agent Hub and composer UX | FX-BE-119 | Implemented |
| FX-BE-121 | End-to-end compatibility and documentation | FX-BE-118, FX-BE-120 | Implemented |

## Definition of done

A single Praxis agent profile can be selected with any compatible provider and host. The same workflow can run through ACP, gateway and local-tool execution. Praxis shows the selected profile, provider, host, skills and activation modes separately; no provider is claimed to support a native skill unless it confirms that capability; old manifests remain readable and receive migration guidance; focused and desktop tests pass.

## Implemented

- Canonical provider, runtime-host, AGENT.md profile, skill, activation and binding contracts.
- Separate profile and host discovery with legacy brief.md and agent.json compatibility.
- Explicit workflow profile/provider/host/skill fields, migration, preflight, dependency readiness and dispatch context.
- Session launch and persistence of profile id, host id, provider, skills and activation modes.
- Agent Hub creation/import/detail/navigation for profiles, runtime hosts and skills.
- Workflow Designer selectors for profile, provider, runtime host and skills.
- Profile-to-host session launch UI, runtime diagnostics, Settings paths/counts and command-palette entries.
- Confirmed HTTP native skill activation with tools/context fallback and deterministic stub-host coverage.

## Verification

Ran to completion in a full local checkout on 2026-09-14:

- `npm run check-types` — clean across every workspace (core, desktop main, desktop renderer, mobile, mobile-protocol).
- `npm run test:core` — 1066/1066 passing. Two pre-existing failures were found and fixed: `fullSdlcTemplates.test.ts`'s bundled-agent readiness test didn't pass `catalog.profiles` (now uses `discoverAgentProfiles([], [], true)`, since `preflightStage` requires a matching profile once a node names one), and a stale assertion string for the renamed "runtime host ... available for installation" dependency reason.
- `npm run test:desktop` (functional project) — 263/263 passing after fixing three real issues this pass surfaced:
  - **Production bug**: `workflowIpc.ts`'s `catalogSnapshot()` (backing the New Workflow dialog's template-readiness display) dropped `runtimeHosts`/`profiles` from the live catalog snapshot, so every bundled-agent stage showed a false "profile not found" / "Missing agents" warning even though the same stage starts and runs fine via `workflowAgentStage.ts` (which already carried both fields). Fixed to match.
  - `aiBrowser.spec.ts` asserted a tool's raw output text directly in the chat transcript; that content now lives under the session inspector's Activity tab (`ToolCompletionGadget`) per the chat-gadgets redesign — every sibling ACP test file was already updated for this, this one was missed. Updated to match.
  - `verify-marketplace.spec.ts` used an ambiguous `getByRole('button', { name: /appearance/i })` locator that started matching two buttons; switched to the established `settings-nav-appearance` / `settings-nav-appearance-themes` test-id pattern used elsewhere, and generated its never-committed baseline screenshots.
  - Six stale visual snapshot baselines (Agent Hub, app shell, marketplace panels, project home) were regenerated against the new profile/host-aware UI after visually confirming each diff was an intentional layout change, not a regression.
- **Known pre-existing flake, unrelated to this feature**: `marketplace.spec.ts`'s "Themes marketplace filter toggle" screenshot has a timing-sensitive "Recent themes" card count/order that doesn't always settle before the screenshot fires (~75% pass rate observed across repeated runs even after adding a stabilization wait). Root cause looks like the Recent-themes list reacting to interaction history from earlier in the same test with its own async timing, independent of the profile/host separation work — flagged rather than chased further to avoid scope creep.
- **Security note surfaced during this pass, not fixed here pending owner confirmation**: `verify-marketplace.spec.ts` had a hardcoded, live GitHub personal access token committed in plaintext. Flagged to the repo owner for revocation; not scrubbed from history without their say-so.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Dependencies



## Comments


