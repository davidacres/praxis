# TASK-502 supplemental Praxis Test contracts

Runner: **node:test**, in `apps/praxis-desktop/main/src/main/notesStore.test.ts` (run by `npm run test:git --workspace=@praxis/desktop-main`). The generated inventory indexes only Playwright, so these are listed here. IDs use the SHA1(file + newline + title) convention. The Playwright journeys for this task are in [catalog.json](catalog.json) under `notesPersistence.spec.ts`, `sidebarNotes.spec.ts` and `noteSessionHandoff.spec.ts`; `notesShelfGeometry.spec.ts` uses parameterised titles, which the generator skips, so its tests are described below. Earlier contracts: [task-501-notes.md](task-501-notes.md).

## PT-EE0D9251E0

**Title:** a stray temp file from an interrupted write is ignored, and the last committed data loads

**Given:** a store with one committed note and a half-written `*.tmp` beside the file.
**When:** a new store lists, then writes.
**Then:** the committed note loads, the next write succeeds, and the stray file is neither read nor removed.

## PT-38B10457B6

**Title:** ungrouping persists across a restart: the note stays, the other group and the order are unchanged

**Given:** three notes in two groups, one membership list replaced.
**When:** a fresh store lists.
**Then:** all notes remain, the edited group has the new members in order, the other group is unchanged.

## PT-9ADEFD3FA6

**Title:** deleting a note persists across a restart: no group in any project still points at it

**Given:** a note in two groups of project A and an unrelated group in project B.
**When:** the note is deleted and a fresh store lists both projects.
**Then:** A has no note or membership for it, B is unchanged.

## notesShelfGeometry.spec.ts (not in the smoke set; measures a real window)

- **Rail width and inset, compact (scale 1) and large (1.16):** the rail is 14 x `--ui-scale` wide (+/-0.5px); measured with `.session-shelf__actions` hidden (the pre-TASK-498 rail) and shown, width and the gap to `main-content-pane` match; both controls sit inside the rail.
- **Full rail:** with eight seeded sessions (five shown) width and inset are unchanged, both controls are inside the rail and visible, and neither the spines nor the actions overflow sideways.
- **Keyboard focus:** focusing either control leaves the rail and workspace unmoved, and the focus ring stays within the rail.
- **Open notes card:** the sleeve starts flush with the rail's right edge; rail width and workspace inset are unchanged.
- **Colour scheme and 110% zoom:** `emulateMedia` light and dark, and titlebar zoom 110%, keep the rail at 14 x scale in CSS pixels. The colour-scheme runs only emulate the media query; they do not switch the app's theme setting. They write `.praxis/session-artifacts/notes-rail-<scheme>.png`.
