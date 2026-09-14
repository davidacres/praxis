---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-306
title: "Define plugin source, marketplace entry, and manifest contracts"
status: Proposed
story: FX-BE-107
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-107]
---

# TASK-306: Define plugin source, marketplace entry, and manifest contracts

## Objective

Add `PluginSource` (a marketplace's own git URL + optional ref), `PluginMarketplaceEntry`
(one `marketplace.json` plugin listing), and `PluginManifest` (a resolved
`.claude-plugin/plugin.json`) to `@praxis/core`, matching the fields Anthropic's and
GitHub's live marketplaces actually populate.

## Implementation notes

- Base the shape directly on `anthropics/claude-plugins-official` and
  `github/copilot-plugins`'s `.claude-plugin/marketplace.json` — fields seen in
  both: `name`, `description`, `author`/`owner`, `category`, `homepage`, `keywords`,
  `license`, `repository`, and `source` as either `{source: 'git-subdir', url, path,
  ref, sha}` or `{source: 'github', repo, path}`. Treat unknown fields as forward-
  compatible passthrough rather than a parse failure.
- `marketplace.json` also carries a top-level `renames` map (old plugin name → new) —
  model it; a source resolved without it must not break lookups by old name.
- Keep this file free of any execution/IO — it is a pure data contract module,
  matching `packages/core/src/ai/agentContracts.ts`'s style from FX-BF-038.

## Acceptance criteria

- Types compile against real snapshots of both repos' `marketplace.json` without
  lossy narrowing.
- Unknown/future fields round-trip rather than being dropped.
- Exported from `@praxis/core`'s public entry point.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:core` for the new contract's fixture-based parse tests and
`npm run check-types` across workspaces.

## Description


## Dependencies



## Comments
