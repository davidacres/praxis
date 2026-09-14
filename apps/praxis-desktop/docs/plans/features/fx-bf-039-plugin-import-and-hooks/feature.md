---
**Status:** 📝 Proposed
**Created:** 2026-09-14
**Type:** Feature
**Priority:** High
id: FX-BF-039
slug: plugin-import-and-hooks
title: "Import Claude Code / Copilot plugins; add a visual, native cross-provider hook engine"
status: Proposed
updated: 2026-09-14
dependencies: [FX-BF-009, FX-BF-018, FX-BF-038]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# FX-BF-039: Import Claude Code / Copilot plugins; add a visual, native cross-provider hook engine

## Outcome

Praxis's agent-profile and skill catalog can be populated from any marketplace that
publishes the `.claude-plugin/marketplace.json` format — including Anthropic's
`claude-plugins-official` and GitHub's `copilot-plugins`, which both use it — without
adopting either vendor's runtime as a dependency. Praxis also gains its own lifecycle
hook engine that works the same way regardless of provider or runtime host, with a
passthrough so a plugin's native `hooks.json` still runs unmodified under Claude Code
itself. Both surfaces are built to be visibly, usably better than what either source
ecosystem offers today — Claude Code's plugin discovery is a `/plugin` TUI menu and
its hooks are hand-written JSON plus shell/python scripts; Praxis has a real desktop
UI and product designers, and this feature should read like it.

## Problem

`claude-plugins-official` and `copilot-plugins` are both curated, actively maintained
directories of agents, skills, and MCP servers — GitHub Copilot's repo ships the exact
same `.claude-plugin/marketplace.json` schema Anthropic's does, so this is a de facto
cross-vendor format, not single-vendor lock-in. Rebuilding that catalog by hand inside
Praxis's own add-on marketplace (FX-BF-018) means Praxis starts from zero content and
stays there; every plugin authored for either ecosystem is invisible to Praxis users
until someone manually ports it.

At the same time, neither ecosystem's plugin format is something Praxis can run
as-is. A plugin's `agents/*.md` and `skills/*/SKILL.md` are provider-neutral
markdown+frontmatter — they map cleanly onto Praxis's existing `AgentProfile` /
`AgentSkillRef` contracts (FX-BF-038) regardless of which runtime host ends up
executing them. A plugin's `hooks/` directory does not: those scripts assume they are
running inside Claude Code's (or Copilot's) own process, wired to that tool's own
hook protocol. Praxis sessions can be bound to Claude Code, Codex, Copilot, or a
direct API provider interchangeably — a hook tied to one host's execution model
silently does nothing (or errors) under the other three. Praxis also has no lifecycle
hook concept of its own today, so there is no cross-provider fallback to offer.

A first pass at scoping this treated both surfaces as plumbing: a plugin browser
that mirrors FX-BF-018's plain Add-ons settings list, and a hook engine with no
authoring UI at all — a user could install someone else's hooks but never build
their own without hand-writing the native format, which is worse than what Claude
Code already offers. Given the explicit goal is to be *better* than the source
ecosystems, not merely compatible with them, the visual design of both surfaces is
part of this feature's scope, not an implementation detail left to whoever builds
the settings panel.

## Canonical model (additions to FX-BF-038)

| Concept | Responsibility |
| --- | --- |
| Plugin source | A `.claude-plugin/marketplace.json`-shaped registry (git-hosted), added by URL, distinct from Praxis's own FX-BF-018 add-on registry |
| Imported plugin | One marketplace entry, resolved and pinned by ref/sha like the upstream marketplace already does |
| Conversion | Deterministic mapping from a plugin's `agents/*.md`, `skills/*/SKILL.md`, `commands/*.md`, and `.mcp.json` into Praxis's `AgentProfile`, `AgentSkillRef`, and MCP server config |
| Native hook | A Praxis-defined lifecycle hook (event, matcher, action) that runs identically no matter which runtime host the session is bound to, authored visually or imported |
| Host-native hook | An imported plugin's own `hooks/hooks.json` definition, run unmodified only when the bound host is the one it was authored for (Claude Code today) |

## Scope

- Add a plugin-source registry, separate from FX-BF-018's add-on marketplace: add/remove
  a marketplace by git URL, list what it publishes, no execution of arbitrary code at
  discovery time.
- Resolve `.claude-plugin/marketplace.json` and each listed plugin's `.claude-plugin/plugin.json`,
  honoring the same `git` / `git-subdir` source shapes and `ref`/`sha` pinning the
  upstream marketplaces already use, cached for offline/rate-limit resilience.
- Convert a plugin's `agents/*.md` into `AgentProfile` records and `skills/*/SKILL.md`
  (plus the legacy `commands/*.md` layout, loaded identically) into `AgentSkillRef`
  records, reusing FX-BF-038's contracts — an imported profile is indistinguishable
  from a bundled or hand-authored one once converted.
- Import a plugin's `.mcp.json` into Praxis's existing MCP server configuration.
- **Design, before building, the visual language for browsing and trusting imported
  content**: a card-based marketplace (in the spirit of the existing theme
  marketplace's live-preview cards, not a plain settings list), a preview of an
  agent's actual instructions / a skill's actual body / a hook's actual behavior
  before install, and a diff view for what changed when a re-trust is required.
- Surface imported plugins in the Agent Hub using that design, with a provenance
  badge naming the source plugin and marketplace so origin is never ambiguous.
- Design and implement a native, provider-neutral hook engine: defined events
  (session start/end, before/after tool call, stage/session failure, at minimum),
  a matcher format, and sandboxed action execution — wired into the session pipeline
  for every runtime host, not just ACP-hosted ones.
- **Build a visual hook builder** — event picker, matcher builder, action picker —
  so a Praxis user can create a native hook without hand-writing JSON or a script,
  plus a hook management view (list, recent firing history, enable/disable/edit).
  This is the feature's clearest opportunity to beat both source ecosystems outright:
  neither offers any hook-authoring UI today.
- Pass an imported plugin's `hooks/hooks.json` straight through, unmodified, when and
  only when the bound runtime host is the one it targets (Claude Code CLI today).
- Best-effort import of a plugin's `hooks.json` matchers into the native hook format
  for use under any other host, explicitly flagging what a given hook actually needs
  (a specific host's own tool semantics) and can't carry over — surfaced in the same
  hook management view, not buried in a log.
- Extend FX-BF-018's existing trust-on-install gate to cover imported plugins and any
  native hook script before it can execute, with a diff view (not a bare re-confirm)
  when an update changes executable content.

## Non-goals

- Depending on the Claude Code or Copilot CLI/runtime to install, resolve, or execute
  a plugin — Praxis reads the same marketplace/plugin files, it does not shell out to
  either vendor's own plugin manager.
- Guaranteeing 1:1 behavioral parity for every hook a plugin defines — a hook that
  depends on a specific host's own tool names or permission model is imported as a
  best-effort translation or marked host-native-only, never silently dropped or
  silently reinterpreted.
- Replacing FX-BF-018's add-on marketplace — that stays the channel for Praxis-native
  add-ons (themes, surface packs, workflow templates); this feature adds a second,
  independent source for agents/skills/hooks specifically.
- Executing arbitrary plugin code at discovery/browse time — conversion of
  agents/skills/MCP config is pure data transformation; only an explicitly installed
  and explicitly trusted hook script ever runs.
- Building a general-purpose visual scripting/automation tool — the hook builder
  covers the event/matcher/action shape this feature defines, not arbitrary logic.

## Delivery order

| Ref | Work | Depends on | Status |
| --- | --- | --- | --- |
| FX-BE-107 | Plugin marketplace contracts and source resolution | — | Proposed |
| FX-BE-108 | Agent/skill/MCP conversion into canonical contracts | FX-BE-107, FX-BF-038 | Proposed |
| FX-BE-109 | Visual design exploration (marketplace, preview, trust/update, hook builder) | FX-BE-108 | Proposed |
| FX-BE-110 | Agent Hub marketplace card UX | FX-BE-109, FX-BE-108 | Proposed |
| FX-BE-111 | Native cross-provider hook engine | FX-BF-038 | Proposed |
| FX-BE-112 | Visual hook builder and management UI | FX-BE-109, FX-BE-111 | Proposed |
| FX-BE-113 | Claude Code hook passthrough and best-effort import | FX-BE-108, FX-BE-111, FX-BE-112 | Proposed |
| FX-BE-114 | Trust, security, and verification | FX-BE-110, FX-BE-113 | Proposed |

## Definition of done

An imported plugin's agents and skills appear in a card-based Agent Hub browser —
not a settings list — with a preview of what they actually say and do before
install, and clearly show which marketplace and plugin they came from. A user can
build a native hook entirely through the hook builder UI, with no JSON or scripting
required, and see it fire in a management view alongside anything imported. A
plugin's own `hooks.json` runs unmodified under Claude Code and is either faithfully
translated or explicitly marked unsupported under every other host — never silently
ignored. Updating a trusted plugin whose scripts or server URLs changed shows a diff,
not a bare re-confirm. Nothing from an imported plugin executes before the user has
explicitly trusted it. Focused and desktop tests pass.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Dependencies



## Comments

