---
**Status:** ✅ Complete
**Created:** 2026-09-10T10:48:08.224Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-048
title: A single naming rule for Praxis files
status: Done
feature: FX-BF-020
updated: 2026-10-10
commits: []
dependencies: []
validation: [npm run check-types, npm run test:desktop]
---

# A single naming rule for Praxis files

## Why

`PROJECT.md` is generic enough to collide with a file a repository already has,
and since FX-BE-047 Praxis only rewrites a file carrying its own markers. So a
repo with its own `PROJECT.md` gets **no Praxis project file at all** — Praxis
neither adopts the existing one nor writes its own. Namespacing removes the
collision rather than arbitrating it.

## Scope

- `PROJECT.md` → **`project.praxis.md`**, matching `board.praxis.json`: same
  folder, same job, same shape, real extension last so it still renders.
- A single exported constant for the filename rather than eight string
  literals, so the next rename is one line.
- The rule recorded in AGENTS.md: **opened by Praxis → `.praxis`; read by
  tooling → `.praxis.<ext>`.**
- This repository's own `PROJECT.md` is renamed in the same commit.

**No migration** — Praxis has not shipped. There is no legacy-name fallback and
no rename-on-next-write.

## Acceptance criteria

- A new folder-backed project writes `project.praxis.md`.
- `projectFileExists` / the wizard's "existing file retained" path read the new
  name.
- No `PROJECT.md` string literal remains in source.

## Validation

- `npm run check-types`
- `npm run test:desktop` (`projects.spec.ts`, `journey.spec.ts`) and the main
  workspace's `projectSnapshot.test.ts`

## Description


## Dependencies



## Comments

**2026-10-10:** Closed during backlog review: all items in this feature are delivered and recorded as Complete in its Items table / 'As built' notes; the header status had not been rolled up.
