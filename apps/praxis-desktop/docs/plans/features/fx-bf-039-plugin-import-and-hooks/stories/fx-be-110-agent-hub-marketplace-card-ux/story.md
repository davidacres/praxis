---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-110
title: "Agent Hub marketplace card UX"
status: Proposed
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-109, FX-BE-108]
---

# FX-BE-110: Agent Hub marketplace card UX

## Outcome

A user can add a marketplace by URL, browse what it publishes as a card grid with
real previews (not a settings list), preview an agent's or skill's actual content
before installing, install it into their catalog with a trust decision backed by an
actual diff, and see it — clearly labeled with its source — everywhere Praxis shows
agents, skills, and MCP servers.

## Tasks

- **TASK-312 Build the marketplace card grid and provenance display** from FX-BE-109's design: add/remove a source, browse its plugins as cards, and show a "from `<plugin>` via `<marketplace>`" badge on every imported item wherever it appears (Agent Hub, workflow designer, session composer).
- **TASK-313 Build the preview-before-install and trust-diff flow**: expand a card to show the actual agent instructions / skill body / MCP server target before install, and show a real diff (not a bare re-confirm) when an update changes something that needs re-trust.

## Acceptance

Adding `github.com/anthropics/claude-plugins-official` as a source shows its plugins
as a browsable card grid within Settings; opening a card shows what the agent
actually says before the user commits to installing it; installing makes it
selectable in the workflow designer and session composer within one Agent Hub
refresh, carrying a visible provenance label everywhere. Removing a plugin removes
its converted agents/skills/servers, and anything currently bound to one is flagged
the same way FX-BF-038's `preflightStage` already reports a missing agent.

## Evidence

E2e coverage: add a source, browse and preview a plugin, install it, confirm its
profile is selectable and labeled correctly in the designer, trigger an update and
confirm the diff view shows the actual change, then remove it and confirm bound
workflow stages surface the now-missing dependency.

## Description


## Dependencies



## Comments
