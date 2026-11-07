---
**Created:** 2026-11-07T21:21:11.983Z
id: TASK-517
type: Task
status: To Do
---

# Port pathSandbox, unifiedDiff, and marketplace archive verifier

**Status:** To Do
**Type:** Task
**Priority:** Medium

## Description

Port `pathSandbox.ts` (canonicalized symlink-aware workspace boundary checks), `networkAddress.ts` (private IPv4/IPv6/loopback/link-local/metadata classification), `unifiedDiff.ts` (multi-hunk patch parsing and fuzzy application), and `packages/core/src/marketplace/` (`.tar.gz` extraction, `sha256` integrity verification, `semver` resolution, and add-on manifest validation) to `crates/praxis-core`.

## Acceptance Criteria

- All unit test suites for `pathSandbox`, `networkAddress`, `unifiedDiff`, and `marketplace` pass in `cargo test -p praxis-core`.

## Dependencies

- `TASK-514`

## Comments


