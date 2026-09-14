---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** Medium
type: Task
id: TASK-309
title: "Import .mcp.json entries into Praxis's MCP server config"
status: Proposed
story: FX-BE-108
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-108]
---

# TASK-309: Import .mcp.json entries into Praxis's MCP server config

## Objective

Convert a plugin's `.mcp.json` (server name → `{type: 'http'|'stdio', url|command,
...}`) into Praxis's existing MCP server configuration, so an imported plugin's MCP
server appears through the same settings surface as a hand-configured one.

## Implementation notes

- Praxis already has MCP server support (OAuth, browser MCP server) — locate the
  existing config shape and add to it; do not create a parallel "imported MCP
  servers" list the rest of the app doesn't know about.
- An id collision with an already-configured server name is a conflict to surface,
  not an overwrite — the user picks which one wins.
- A server's `url`/`command` changing on a plugin update is a trust-relevant change
  (it is a new place code/network calls will actually go) — route it through the
  same diff-based re-trust flow FX-BE-114 defines for imported content generally,
  rather than silently applying the update.

## Acceptance criteria

- An imported `.mcp.json` server is usable identically to a manually configured one.
- A name collision is surfaced, never silently overwritten.
- A URL/command change on update requires re-trust before taking effect.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:core` for the conversion/collision tests and `npm run check-types`
across workspaces.

## Description


## Dependencies



## Comments
