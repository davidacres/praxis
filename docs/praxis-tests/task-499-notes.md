# TASK-499 supplemental Praxis Test contracts

Frozen source: `3b721e79682a3b3d61ec9ff5805b159269a9e37a`. Runner: **node:test**. Six tests added by TASK-499: three in `notesSession.test.ts` (the shared editor state used by both the shelf and the sidebar) and three in the new `notesTree.test.ts` (how the sidebar tree is built from notes and groups). Both files run through `npm test --workspace=@praxis/desktop-renderer`. The generated inventory indexes only Playwright, so its validator does not count these. IDs use the existing SHA1(file + newline + title) convention. No existing IDs were renumbered.

The Playwright journeys for the same task are **PT-2DFB759892** and **PT-0754F5395E** in [catalog.json](catalog.json) (`apps/praxis-desktop/main/e2e/sidebarNotes.spec.ts:39` and `:81`).

The session tests stub `window.praxis.notes` with `createNote` / `updateNote` calls that are recorded in `calls` and can be switched to fail. The tree tests use plain note and group objects.

## PT-EF24B1568D

**Title:** forget resets the draft only when the deleted note is the open one
**Automation:** node:test — [apps/praxis-desktop/renderer/test/notesSession.test.ts:74](../../apps/praxis-desktop/renderer/test/notesSession.test.ts#L74)

**Given:** an open draft saved as note `n1` with body "keep me".
**When:** `forget('other')` is called, then `forget('n1')`.
**Then:** after the first call the body is unchanged; after the second the draft is `{ projectId: 'p', title: '', body: '' }` and not dirty.

## PT-2DF357AC10

**Title:** renameOpen saves the new title through the shared draft
**Automation:** node:test — [apps/praxis-desktop/renderer/test/notesSession.test.ts:86](../../apps/praxis-desktop/renderer/test/notesSession.test.ts#L86)

**Given:** an open draft saved as note `n1`.
**When:** `renameOpen('n1', 'Renamed')` is awaited.
**Then:** exactly one `updateNote` call is made, the draft title is "Renamed" and the save state is `saved`. Renaming a note that is *not* open is not tested.

## PT-8932C374BF

**Title:** unsaved text is mirrored to storage and restored after a restart
**Automation:** node:test — [apps/praxis-desktop/renderer/test/notesSession.test.ts:97](../../apps/praxis-desktop/renderer/test/notesSession.test.ts#L97)

**Given:** an in-memory `localStorage` stub and a failing save.
**When:** a body is edited and flushed; saving is made to succeed and flushed again; a blank draft is started; a stored unsaved draft is planted and `restoreUnsavedDraft()` is called and flushed.
**Then:** the failed save writes the body under `UNSAVED_DRAFT_KEY`; the successful save removes the key; restore returns `true` and the restored text is created as a note and saved. "Restart" means calling the restore function on a module that is already loaded. No real app relaunch is involved.

## PT-6DA0575B35

**Title:** groups list members in order, ungrouped notes newest first, missing links are kept
**Automation:** node:test — [apps/praxis-desktop/renderer/test/notesTree.test.ts:8](../../apps/praxis-desktop/renderer/test/notesTree.test.ts#L8)

**Given:** three notes with different `updatedAt` values, one group "Zed" listing `c`, a missing id `gone`, then `a`, and an empty group "Alpha".
**When:** `buildNotesTree` is called.
**Then:** groups are ordered Alpha, Zed; Zed's members keep their order with `gone` present but unresolved; the only ungrouped note is `b`.

## PT-A1B52A5EE5

**Title:** a note in two groups appears under both and is not ungrouped
**Automation:** node:test — [apps/praxis-desktop/renderer/test/notesTree.test.ts:18](../../apps/praxis-desktop/renderer/test/notesTree.test.ts#L18)

**Given:** one note `a` that is a member of two groups.
**When:** `buildNotesTree` is called.
**Then:** both groups resolve their first member to note `a`, and the ungrouped list is empty.

## PT-1DB2C21417

**Title:** membership helpers return new ordered lists
**Automation:** node:test — [apps/praxis-desktop/renderer/test/notesTree.test.ts:24](../../apps/praxis-desktop/renderer/test/notesTree.test.ts#L24)

**Given:** small membership arrays.
**When:** `addMember`, `removeMember` and `moveMember` are applied.
**Then:** add appends and ignores a duplicate; remove drops the id; move reorders to the index, clamps an out-of-range index to the end, and ignores an unknown id.
