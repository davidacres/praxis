---
**Created:** 2026-11-08T12:00:00.000Z
id: TASK-536
type: Task
status: To Do
---

# Reconcile the migrated channel list and keep TypeScript side effects

**Status:** To Do
**Type:** Task
**Priority:** High

## Description

Make `DEFAULT_MIGRATED_CHANNELS` (`main/src/main/rustHostInstance.ts`) list exactly what the renderer can reach.

- Remove `folderService:*`, `settings:sanitize` and `host:*` from the default list, or give them real TypeScript and preload registrations if the renderer needs them. Today nothing registers them, so they only inflate the count.
- Add a unit test to `rustHostBridge.test.ts` that fails when a listed channel has no `handleOrFallback` registration.
- List the work each delegated channel's TypeScript fallback does besides returning a value (validation, events, cache updates, logging), for git, settings and folder.
- Fix the first known gap: `settings:set` skips mobile-subnet validation when delegated. Either port `normalizeMobileSubnet` validation into `praxis-core` settings sanitisation, or run it as a TypeScript pre-step before calling Rust. Prefer the Rust port so a future Tauri shell keeps it.
- Settle what TypeScript readers see straight after a Rust write. Either the bridge updates `SharedSettingsBackend` with the returned settings, or reads go through Rust too. Do not rely on the file watcher alone.

## Acceptance Criteria

- The channel-registration test exists and passes.
- An invalid mobile subnet is rejected by `settings:set` in both modes.
- The side-effect list is recorded in this task's comments.

## Dependencies

- `TASK-534`

## Comments

