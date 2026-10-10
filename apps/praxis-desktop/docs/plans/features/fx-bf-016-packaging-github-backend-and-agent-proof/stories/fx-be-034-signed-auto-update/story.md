---
**Status:** Blocked
**Created:** 2026-09-05T07:33:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-034
title: Signed auto-update
status: blocked
feature: FX-BF-016
issue: docs/issues/features/fx-bf-016-packaging-github-backend-and-agent-proof/stories/fx-be-034-signed-auto-update/issue.md
updated: 2026-10-10
commits: [30ead0b]
dependencies: []
validation: [npm run build]
---

# Signed auto-update

## User or operational impact

Build-from-source is the single biggest adoption blocker named in the
original review: "start using it" means "maintain a local build," which
nobody does for long.

## Scope

- `electron-updater` wiring and the publish/update-check machinery
  (`apps/praxis-desktop/main/src/main/autoUpdate.ts`) — done, `30ead0b`.
- Actual code signing (macOS notarization, Windows Authenticode) — **not
  started, and not startable by an agent**: it needs the project owner's
  Apple Developer / Windows signing credentials.

## Acceptance criteria

- `npm run app:installer:mac` / the Windows equivalent produce a signed,
  notarized artifact.
- A running install detects and applies an update from the publish feed
  without a manual reinstall.

## Task list

- `30ead0b` — Update checking, and the packaging config signing needs. Done.
- Signing and notarization — blocked on credentials; no task to assign until
  they're available.

## Close when

A user installs a signed build once and it updates itself from then on.

## Description


## Dependencies



## Comments

**2026-10-10:** Status corrected during backlog review: still valid but cannot proceed until the project owner supplies Apple/Windows signing credentials. Frontmatter already said blocked.
