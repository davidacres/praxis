---
**Status:** 📋 Proposed
**Created:** 2026-10-31T02:46:10.661Z
**Type:** Story
**Priority:** Medium
id: FX-BE-189
type: Story
status: To Do
---

# FX-BE-189: Persistent project notes and linked groups

## Goal

Define and persist local project notes independently of sessions and board items.

## Acceptance criteria

- Specify stable IDs, project ownership, timestamps, ordered many-to-many memberships, request snapshots and IPC errors. Validate titles, bodies, missing IDs, cross-project requests and malformed persisted data. Define backward-compatible schema initialisation with no notes. Add meaningful contract tests.
- Use existing app-local store patterns and main/preload IPC conventions. Implement CRUD, membership operations, atomic saves, change notifications and restart restoration. Group removal preserves notes; note deletion cleans memberships. Reject cross-project access. Test round trips, failed writes, group integrity and existing-data startup.

## Dependencies

None

## Description


## Comments
