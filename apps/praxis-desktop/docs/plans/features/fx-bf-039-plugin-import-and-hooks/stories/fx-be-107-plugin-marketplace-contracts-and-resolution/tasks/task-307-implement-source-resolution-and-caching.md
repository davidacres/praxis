---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** High
type: Task
id: TASK-307
title: "Implement marketplace source resolution and caching"
status: Proposed
story: FX-BE-107
feature: FX-BF-039
updated: 2026-09-14
dependencies: [TASK-306]
---

# TASK-307: Implement marketplace source resolution and caching

## Objective

Given a `PluginSource` URL, fetch its `marketplace.json`, resolve each listed
plugin's `.claude-plugin/plugin.json` at its pinned `ref`/`sha`, and persist the
result so a later resolution can serve a stale-but-present listing instead of
nothing when the source is briefly unreachable.

## Implementation notes

- Reuse the existing GitHub API access pattern from FX-BF-018's marketplace client
  (`registryClient.ts`/`marketplaceService.ts`) rather than a second HTTP client —
  this is a sibling registry, not a different transport.
- A `git-subdir` source's `path` + `ref`/`sha` is enough to resolve the plugin's file
  tree without cloning the whole repo — use the GitHub contents API (as this repo's
  own research did) or an equivalent tree API for other git hosts.
- Cache per-source under the same store FX-BF-018 already uses for its own registry
  cache, keyed by source URL, with a last-successful-resolution timestamp surfaced
  to the UI so staleness is visible, never silent.
- A plugin whose pinned `ref`/`sha` no longer resolves (deleted branch, force-pushed
  history) is reported as broken for that one entry, not a failure of the whole
  marketplace listing.

## Acceptance criteria

- A marketplace with 25+ plugins resolves within a reasonable time budget without
  N+1-ing individual file requests where a tree/contents-list call would do.
- Losing network access after a successful resolution still serves the cached
  listing, visibly marked as stale.
- One broken plugin entry does not blank the rest of the marketplace's listing.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:core` against a mocked GitHub API fixture covering a full
resolution, a stale-cache fallback, and one broken plugin entry inside an otherwise
healthy marketplace.

## Description


## Dependencies



## Comments
