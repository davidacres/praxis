---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Story
**Priority:** High
type: Story
id: FX-BE-107
title: "Plugin marketplace contracts and source resolution"
status: Proposed
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BF-018]
---

# FX-BE-107: Plugin marketplace contracts and source resolution

## Outcome

Praxis can add a `.claude-plugin/marketplace.json`-shaped git repository as a plugin
source and resolve what it publishes — reading `marketplace.json` and each listed
plugin's `.claude-plugin/plugin.json`, following `git` / `git-subdir` sources pinned
by `ref`/`sha` — without executing anything from the source. This is pure discovery,
separate from FX-BF-018's existing add-on registry.

## Tasks

- **TASK-306 Define `PluginSource`, `PluginMarketplaceEntry`, and `PluginManifest` contracts in core**, modeled directly on the fields actually used by `anthropics/claude-plugins-official` and `github/copilot-plugins` (name, description, author, category, source `{source, url, path, ref, sha}` for `git-subdir`, or `{source: 'github', repo, path}`).
- **TASK-307 Implement source resolution and caching**: fetch a marketplace's `marketplace.json`, resolve each plugin's file tree at its pinned ref/sha, and cache the result so a rate-limited or offline git host degrades to "last known listing" rather than an empty catalog.

## Acceptance

Adding a marketplace URL lists every plugin it publishes, with the exact name,
description, author, and source pinning the upstream file declares — verified
against a fixture built from real `marketplace.json` snapshots of both repos, not a
synthetic shape. Nothing under `plugins/<name>` is read or executed at this stage;
only `.claude-plugin/plugin.json` and the file listing are resolved.

## Evidence

Unit tests in `packages/core` covering marketplace parsing (both `git-subdir` and
`github` source shapes, the `renames` field, and a marketplace with an unreachable
plugin source degrading gracefully) plus a cached-listing test proving a second
resolution survives the source being briefly unreachable.

## Description


## Dependencies



## Comments
