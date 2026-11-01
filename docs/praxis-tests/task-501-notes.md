# TASK-501 supplemental Praxis Test contracts

Frozen source: `fb0747003babcaaa88b8ad0e238624f1b0dad6a5`. Runner: **node:test**. TASK-501 adds two tests: one in `noteSendReference.test.ts` (the provenance recorded with a note snapshot) and one in `noteSendStore.test.ts` (when the dialog's unsent instruction is cleared). Both run through `npm test --workspace=@praxis/desktop-renderer`. The generated inventory indexes only Playwright, so its validator does not count these. IDs use the existing SHA1(file + newline + title) convention. No existing IDs were renumbered.

The Playwright journeys for the same task are **PT-6C43ED01A2**, **PT-7C9174A432**, **PT-F56F3DC1A3**, **PT-91DB826501** and **PT-3FA587C66D** in [catalog.json](catalog.json) (`apps/praxis-desktop/main/e2e/noteSessionHandoff.spec.ts:137`, `:161`, `:179`, `:194`, `:213`). TASK-500's contracts are in [task-500-notes.md](task-500-notes.md).

## PT-FF8CD95C75

**Title:** a reference records provenance as a copy, and only the raw message carries it
**Automation:** node:test — [apps/praxis-desktop/renderer/test/noteSendReference.test.ts:47](../../apps/praxis-desktop/renderer/test/noteSendReference.test.ts#L47)

**Given:** a group snapshot for project `p`, source group `src` titled "Src", with notes `b` "Second" then `a` "First", each with `updatedAt` `t`.
**When:** `snapshotToReference` is called; afterwards the first note's title is changed to "edited" and the last note is removed from the array; the reference is then wrapped with `withSessionContext('go', …)` and shown with `displaySessionContext`.
**Then:** `reference.snapshot` equals `{ projectId: 'p', source: { kind: 'group', id: 'src', title: 'Src' }, notes: [{ id: 'b', title: 'Second', updatedAt: 't' }, { id: 'a', title: 'First', updatedAt: 't' }] }`; after the edits it still has 2 notes and the first is still "Second"; the raw message contains `"updatedAt":"t"` and `"projectId":"p"`; the displayed receipt is exactly "go\n\nContext: Group: Src (2 notes)", so provenance is not shown in the chat. The single-note (`kind: 'note'`) provenance is not asserted.

## PT-3091915D5B

**Title:** the saved instruction survives staging and is cleared only when the handoff is taken
**Automation:** node:test — [apps/praxis-desktop/renderer/test/noteSendStore.test.ts:31](../../apps/praxis-desktop/renderer/test/noteSendStore.test.ts#L31)

**Given:** note source `n9` in project `p` with the draft instruction "keep me".
**When:** a handoff carrying `draft: { projectId: 'p', source }` is staged under key `d`, then taken; "typed again" is saved; `takeSessionHandoff('d')` is called a second time.
**Then:** the draft still reads "keep me" after staging; it reads "" after the take; the second take returns `undefined` and leaves "typed again" in place. This is the store rule only. The e2e contract PT-91DB826501 shows the instruction surviving a lost destination in the dialog.
