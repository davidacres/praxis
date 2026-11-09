---
**Created:** 2026-11-08T12:00:00.000Z
id: TASK-536
type: Task
status: Done
---

# Reconcile the migrated channel list and keep TypeScript side effects

**Status:** Done
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

- 2026-11-08: As a stopgap, `settings:set` has been removed from `DEFAULT_MIGRATED_CHANNELS`, with a comment pointing here, so the TypeScript handler still validates subnets. Put it back once the validation lives in Rust.

### 2026-11-09 — completed channel reconciliation and safe delegation

- Defaults now contain only the 33 git channels, `settings:get`, and `folder:discoverPlans` exposed through preload and registered with `handleOrFallback`. Removed internal host RPCs, settings helpers, folderService RPCs, and folder/plans helpers without preload exposure. Internal RPC handlers remain available for direct host use and tests.
- An AST-based test checks every default against real desktop registrations and preload invokes, including duplicate detection. Updated the prior test that asserted unreachable defaults existed.
- Rust already validates invalid subnet entries in `SharedSettingsStore::write`. Extracted the existing TypeScript IPC validation into a small tested helper; a real-host regression test proves both paths reject invalid entries before creating a settings file.
- Deliberate cutover decision: keep `settings:set` on TypeScript by default. That preserves immediate cache visibility and existing `onDidChange` subscribers without introducing a second desktop settings writer. Do not re-enable Rust settings writes until TASK-537 proves shared-file write coordination, synchronous cache adoption and notification deduplication. Direct host RPC tests are not production write-cutover evidence.
- Transport failures now surface to the caller instead of replaying a possibly completed mutation in TypeScript. Only an explicit `CHANNEL_NOT_REGISTERED` reply permits fallback. A regression test proves no fallback after a simulated post-write disconnect.
- Host exit/error clears readiness, registered channels and startup state, allowing a fresh process on the next request. A real subprocess test proves restart; startup timeout terminates the unready child.

Side-effect inventory for delegated desktop channels:

| Domain | TypeScript behavior beyond return value | Decision |
| --- | --- | --- |
| Settings | `settings:set` validates input, persists, updates the synchronous cache, fires subscribers and broadcasts `settings:changed`; the watcher handles external edits. | Keep writes on TypeScript; `settings:get` remains a Rust disk read. Existing cross-process writer risks are not claimed resolved. |
| Git | Service helpers resolve the configured executable, perform filesystem/Git mutations and maintain the TypeScript repository cache. | Rust owns execution for delegated calls; preserve the fallback service and compare cache/refresh outcomes in TASK-537. Never replay after uncertain transport failure. |
| Folder discovery | Resolve the connection, validate folder mode/configured roots, discover across roots and deduplicate paths case-insensitively. | Keep the reachable `folder:discoverPlans` channel; its existing real-host parity test exercises connection-id discovery. Other folder/plans helpers are internal rather than default renderer channels. |

Verification: desktop main compilation and trusted-sender checks pass; `npm run test:git` passes 186/186 with localhost access, including real Rust-host bridge tests. The restricted run encountered localhost EPERM and a Node native assertion in another suite; the unchanged rerun passed. No renderer/UI files changed; desktop E2E and visual inspection were not run. The parent bridge gate remains open for packaging and full dual-mode parity.
