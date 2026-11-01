# TASK-497 supplemental Praxis Test contracts

Frozen source: `20ddf0f8e93ab69502d0bbcb5322b30c699d8ce3`. Runner: **node:test**. Fourteen tests in one file, registered in `test:git` in [desktop main package.json](../../apps/praxis-desktop/main/package.json) and run by the root `npm run test` through `test:desktop:git`. The generated inventory indexes only Playwright, so its validator does not count these. IDs use the existing SHA1(file + newline + title) convention. Three cases come from one parameterized `test(\`${label} …\`)` call at line 91; each is listed under its expanded title. No existing IDs were renumbered.

The Playwright journey for the same task is **PT-3C92E05E68** in [catalog.json](catalog.json) (`apps/praxis-desktop/main/e2e/notes.spec.ts:29`).

All store tests use a real temporary directory, a fixed project registry (`project-a`, `project-b`), a deterministic clock and ID source, and a change listener that records project IDs. Some tests inject a wrapped `fs.promises` to fail or count specific calls.

## PT-D561C40BDB

**Title:** missing file lists empty and writes nothing until the first mutation
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:44](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L44)

**Given:** no notes file exists.
**When:** project A is listed, then a note is created.
**Then:** the list is empty and the file still does not exist; after the first create it exists.

## PT-922ACE7DB3

**Title:** round trip survives a new store on the same file, in order
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:52](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L52)

**Given:** a store that creates two notes and a group, reorders the group, clears one note's body and renames the group.
**When:** a second store is opened on the same file.
**Then:** it lists exactly what the first store held: the empty body, the new group title and the reordered membership. Six change notifications were emitted, one per mutation.

## PT-04C7D12B91

**Title:** existing valid data is loaded on startup
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:70](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L70)

**Given:** a hand-written schema-version-1 file with one note and a group containing it.
**When:** a new store lists project A.
**Then:** one note and the group's membership `['n']` are returned.

## PT-CDBBA295F5

**Title:** malformed JSON yields a typed error and the file is left untouched
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:91](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L91) (parameterized case)

**Given:** a notes file containing invalid JSON.
**When:** the store lists, then tries to create a note.
**Then:** both return `INVALID_PERSISTED_DATA`, the file's bytes are unchanged and no change notification fires.

## PT-6C3A61B2C1

**Title:** unsupported schema yields a typed error and the file is left untouched
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:91](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L91) (parameterized case)

**Given:** a notes file declaring `schemaVersion: 99`.
**When:** the store lists, then tries to create a note.
**Then:** both return `UNSUPPORTED_SCHEMA`, the file's bytes are unchanged and no change notification fires.

## PT-16907A2B00

**Title:** dangling member yields a typed error and the file is left untouched
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:91](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L91) (parameterized case)

**Given:** a version-1 file whose group references a note that does not exist.
**When:** the store lists, then tries to create a note.
**Then:** both return `INVALID_PERSISTED_DATA`, the file's bytes are unchanged and no change notification fires.

## PT-96B828D1AA

**Title:** a failed write reports PERSISTENCE_FAILURE, keeps memory, cleans up and recovers
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:102](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L102)

**Given:** a store with one saved note, whose `rename` is then made to throw an error that names a path.
**When:** a second note is created, then `rename` is restored and a third note is created.
**Then:** the failed create returns `PERSISTENCE_FAILURE` with no directory, body text or error path in the result; the in-memory list equals the state before the attempt; no `.tmp` file is left behind; no notification fires for the failure. The next create succeeds and notifies.

## PT-F6E2585D72

**Title:** deleting a group keeps its notes; deleting a note cleans every membership in one write
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:131](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L131)

**Given:** two notes, both members of two groups in opposite orders, with `writeFile` calls counted.
**When:** one note is deleted, then one group is deleted, and each result is reread through a fresh store.
**Then:** the note delete costs exactly one write and removes it from both groups on disk; the group delete leaves the remaining note on disk and only the other group.

## PT-332E268E96

**Title:** membership rules: unknown, duplicate and empty updates are rejected without change
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:151](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L151)

**Given:** a note in a group.
**When:** memberships are replaced with an unknown ID and with a duplicate, and a note is updated with `{}`.
**Then:** the results are `NOTE_NOT_FOUND`, `VALIDATION_ERROR` and `VALIDATION_ERROR`; the listed state and the notification count are unchanged.

## PT-899DBBA933

**Title:** project isolation across every operation
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:164](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L164)

**Given:** a note and group in project B and a note and group in project A.
**When:** A attempts update/delete of B's note and group, membership replacement on B's group, adding B's note to A's group or a new A group, and a snapshot of B's note; an unknown project lists and creates.
**Then:** every cross-project call returns `PROJECT_MISMATCH`, the unknown project returns `PROJECT_NOT_FOUND`, and A's list contains only A-owned records.

## PT-DAAFD76BFA

**Title:** concurrent creates all persist; reads and snapshots never notify
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:184](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L184)

**Given:** an empty store.
**When:** twenty creates are started at once, then a list and a note snapshot are taken.
**Then:** twenty notifications fire, a fresh store reads twenty notes from disk, and the list and snapshot add no notification.

## PT-769717FF0D

**Title:** snapshots are detached and empty groups are refused
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:194](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L194)

**Given:** a note with body `original` and an empty group.
**When:** the group is snapshotted, the note is snapshotted, and the note is then edited.
**Then:** the group snapshot returns `EMPTY_GROUP`; the note snapshot still holds `original` after the edit.

## PT-7AB52FB741

**Title:** a backwards clock never makes updatedAt precede createdAt
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:204](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L204)

**Given:** an explicit clock variable that the test sets back one day after a note and a group containing it are created. The result does not depend on how many times the store reads the clock.
**When:** the note is updated, then deleted (which removes it from the group and restamps the group).
**Then:** the updated note's `updatedAt` equals its `createdAt`; a fresh store on the same file loads, and the group has no members and an `updatedAt` equal to its `createdAt`.

## PT-CE269CF17F

**Title:** a transient read failure is retried instead of disabling notes for the session
**Automation:** node:test — [apps/praxis-desktop/main/src/main/notesStore.test.ts:223](../../apps/praxis-desktop/main/src/main/notesStore.test.ts#L223)

**Given:** a `readFile` that throws `EBUSY` once.
**When:** the store lists twice, then creates a note.
**Then:** the first list returns `PERSISTENCE_FAILURE`; the second list returns an empty collection and the create succeeds.
