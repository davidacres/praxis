---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Story
**Priority:** High
type: Story
id: FX-BE-108
title: "Agent/skill/MCP conversion into canonical contracts"
status: Proposed
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-107, FX-BF-038]
---

# FX-BE-108: Agent/skill/MCP conversion into canonical contracts

## Outcome

A resolved plugin's `agents/*.md` and `skills/*/SKILL.md` (plus the legacy
`commands/*.md` layout, loaded identically) convert deterministically into
FX-BF-038's `AgentProfile` and `AgentSkillRef` contracts, and its `.mcp.json`
imports into Praxis's existing MCP server configuration — so once converted, an
imported agent or skill is indistinguishable from a bundled or hand-authored one to
every downstream consumer (preflight, workflow binding, Agent Hub).

## Tasks

- **TASK-308 Convert `agents/*.md` and `skills/*/SKILL.md` into `AgentProfile`/`AgentSkillRef`**, reconciling frontmatter fields that don't exist on Praxis's contracts today (a subagent's `model`/`color`/`tools`, a skill's `argument-hint`/`allowed-tools`) as informational metadata rather than dropping them silently.
- **TASK-309 Import `.mcp.json` entries into Praxis's MCP server config**, with id-collision detection against already-configured servers and a re-trust prompt when an update changes a server's URL/command.

## Acceptance

An imported plugin's profile appears in `discoverAgentProfiles`'s output exactly like
a bundled one — same shape, same trust/scope semantics — and its skill(s) appear in
`discoverSkills`'s output the same way. A workflow stage can bind to an imported
profile with zero code path differences from binding to a hand-authored one. An
`.mcp.json` entry becomes a configured MCP server without a second, parallel MCP
config surface.

## Evidence

Fixture-based conversion tests using real `agents/*.md` and `skills/*/SKILL.md`
content pulled from `claude-plugins-official`'s `hookify` and `example-plugin`
plugins (already inspected during scoping), plus a workflow-binding test proving an
imported profile satisfies `preflightStage` identically to a bundled one.

## Description


## Dependencies



## Comments
