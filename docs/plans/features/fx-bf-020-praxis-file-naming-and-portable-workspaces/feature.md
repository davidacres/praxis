---
**Status:** 📋 Proposed
**Created:** 2026-09-06T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-020
slug: praxis-file-naming-and-portable-workspaces
title: Praxis files are namespaced, and a workspace file is portable
status: complete
owner: Electron desktop app
updated: 2026-09-06
issues: docs/issues/features/fx-bf-020-praxis-file-naming-and-portable-workspaces/feature-issues.md
stories: [FX-BE-048, FX-BE-049, FX-BE-050]
validation: [npm run check-types, npm run test:core, npm run test:desktop]
---

# FX-BF-020: Praxis files are namespaced, and a workspace file is portable

## Outcome

Every file Praxis writes into a user's folder is identifiable as Praxis's, and a
workspace file can be committed and opened by someone else.

## The naming rule

The codebase already had two conventions and both are justified, so this is a
rule rather than a preference:

| pattern | example | why |
| --- | --- | --- |
| `.praxis` **is the extension** | `praxis-code.workspace.praxis.json` | the user *opens it with Praxis* — OS file association and the picker filter depend on it (`workspaceFile.spec.ts` asserts the filter) |
| `.praxis.<ext>` **is a middle segment** | `board.praxis.json` | tooling reads it — keeping the real extension last preserves editor highlighting and GitHub rendering |

`PROJECT.md` is the only Praxis file that followed neither. It becomes
**`project.praxis.md`**: same folder and same job as `board.praxis.json`, so it
takes the same shape.

### Why the generic name was an actual bug, not just untidy

`writeProjectSnapshot` only rewrites a file carrying Praxis's markers
(FX-BE-047). A repository that already has its own `PROJECT.md` — a common
enough name — therefore gets **no Praxis project file at all**, silently:
Praxis will not adopt the existing one, and will not create its own beside it.
Namespacing removes the collision instead of arbitrating it.

## Portability

A workspace file stores `workspaceFolder` and folder-connection `roots` as
absolute paths (`/Users/daveacres/dev/tools/praxis`), so a committed workspace
resolves on exactly one machine. Paths inside the workspace file's own tree are
written **relative to the file**; a folder outside that tree stays absolute,
because there is nothing sensible to make it relative to.

That is a functional distinction, not a compatibility one.

## Scope

- **`FX-BE-048`** — the naming rule; `PROJECT.md` → `project.praxis.md`.
- **`FX-BE-049`** — workspace files store in-tree paths relative to themselves.
- **`FX-BE-050`** — the workspace file becomes `.praxis.json`, collapsing the rule to one form.

**No migration.** Praxis has not shipped, so there is no installed base to carry:
no legacy-name fallback, no path-shape upgrade, no one-time rename. This
repository's own files are updated in the same commits.

## Close when

Every file Praxis writes carries `praxis` in its name, and this repository's
`praxis-code.workspace.praxis.json` can be cloned to a different path and opened
without editing.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-048 | Story | A single naming rule for Praxis files | Complete |
| FX-BE-049 | Story | Workspace files store in-tree paths relative to themselves | Complete |
| FX-BE-050 | Story | A workspace file is .praxis.json, not .praxis | Complete |

## Description


## Dependencies



## Comments


