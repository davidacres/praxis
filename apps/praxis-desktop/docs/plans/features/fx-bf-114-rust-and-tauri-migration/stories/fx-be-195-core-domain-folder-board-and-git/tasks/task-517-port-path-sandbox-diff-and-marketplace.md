---
**Created:** 2026-11-07T21:21:11.983Z
id: TASK-517
type: Task
status: Done
---

# Port pathSandbox, unifiedDiff, and marketplace archive verifier

**Status:** Done
**Type:** Task
**Priority:** Medium

## Description

Port `pathSandbox.ts` (canonicalized symlink-aware workspace boundary checks), `networkAddress.ts` (private IPv4/IPv6/loopback/link-local/metadata classification), `unifiedDiff.ts` (multi-hunk patch parsing and fuzzy application), and `packages/core/src/marketplace/` (`.tar.gz` extraction, `sha256` integrity verification, `semver` resolution, and add-on manifest validation) to `crates/praxis-core`.

## Acceptance Criteria

- All unit test suites for `pathSandbox`, `networkAddress`, `unifiedDiff`, and `marketplace` pass in `cargo test -p praxis-core`.

## Dependencies

- `TASK-514`

## Comments

- 2026-11-08: Done. `crates/praxis-core` now has `sandbox` (symlink-aware containment, `O_NOFOLLOW` + inode-pinned open/read/write/list), `unified_diff` (`createUnifiedDiff`), extra `network_address` coverage, and `marketplace` (`catalog_types`, `semver`, `addon_manifest`, `integrity` SRI/shasum, `tarball_manifest` capped in-memory USTAR reader). Every TS test case is ported; `cargo test -p praxis-core` passes 104/104.
- Scope note: `unifiedDiff.ts` only *generates* diffs — there is no TS patch parser or fuzzy applier, so none was ported despite the description. `registryClient.ts` and `marketplaceService.ts` (HTTP + on-disk install storage) are service orchestration and remain to be ported when the marketplace IPC channels move to `praxis-host`.
