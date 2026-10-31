# TASK-496 supplemental Praxis Test contracts

Frozen source: `880dc9a6ebef73cf4a96a73148d8fe1b352ce72b`. Runner: **node:test**. Nine tests registered in [core package.json](../../packages/core/package.json). These supplement the Playwright-only generated inventory; they are not counted by its validator. IDs use the existing SHA1(file + newline + title) convention. No existing IDs are renumbered.

## PT-212D8FD0B1

**Title:** single note and ordered group captures preserve provenance through later edits and deletion
**Automation:** node:test — [packages/core/src/notes/noteSnapshot.test.ts:11](../../packages/core/src/notes/noteSnapshot.test.ts#L11)

**Given:** a project with two notes and a group ordered b, a.
**When:** single-note and group snapshots are captured, then source records are edited and deleted.
**Then:** the group snapshot retains order, provenance, project and capture time; note fields remain copied and the group snapshot survives JSON round trip.

## PT-2B8CC00CB1

**Title:** empty/incomplete/foreign groups and malformed sources fail without captures
**Automation:** node:test — [packages/core/src/notes/noteSnapshot.test.ts:28](../../packages/core/src/notes/noteSnapshot.test.ts#L28)

**Given:** a notes fixture and known project registry.
**When:** capture is requested with missing projects, malformed sources/time, foreign groups, empty groups, missing members or foreign members.
**Then:** tested requests fail with the expected typed codes and no body content in the failure.

## PT-2736E32C0B

**Title:** future IPC snapshot result narrows and uses JSON-compatible failures
**Automation:** node:test — [packages/core/src/notes/noteSnapshot.test.ts:44](../../packages/core/src/notes/noteSnapshot.test.ts#L44)

**Given:** a function typed as the future NotesIpc.prepareSnapshot method.
**When:** a missing note is requested.
**Then:** the result narrows to NOTE_NOT_FOUND and survives JSON serialization; no real IPC transport is exercised.

## PT-780F67F095

**Title:** absent storage initializes independently; null, nested corruption and unsupported versions fail closed
**Automation:** node:test — [packages/core/src/notes/noteValidation.test.ts:16](../../packages/core/src/notes/noteValidation.test.ts#L16)

**Given:** absent storage or malformed/versioned input.
**When:** parseNotesDocument receives undefined, null, invalid shapes, corrupt entries or schema version 2.
**Then:** undefined returns version 1 with empty notes/groups; tested malformed values return INVALID_PERSISTED_DATA and version 2 returns UNSUPPORTED_SCHEMA.

## PT-18D794703A

**Title:** round trip preserves stable identities, shared ordered links and exact Unicode bodies without aliasing
**Automation:** node:test — [packages/core/src/notes/noteValidation.test.ts:23](../../packages/core/src/notes/noteValidation.test.ts#L23)

**Given:** two notes shared by two groups in b, a order with Unicode bodies.
**When:** the JSON fixture is parsed, then returned content and order are changed.
**Then:** parsed values initially equal the fixture and modifying the result leaves the original fixture unchanged; the original remains parseable.

## PT-D46A865FCF

**Title:** stored identity, timestamps and membership integrity reject invalid data
**Automation:** node:test — [packages/core/src/notes/noteValidation.test.ts:34](../../packages/core/src/notes/noteValidation.test.ts#L34)

**Given:** valid stored notes and groups.
**When:** identity, title, timestamps or memberships are corrupted individually.
**Then:** tested blank IDs/titles, invalid or reversed timestamps, duplicate/colliding IDs, duplicate/missing/nested/foreign links fail with INVALID_PERSISTED_DATA; an empty group is accepted.

## PT-8E6A92402A

**Title:** title and body boundaries use UTF-16 units; whitespace bodies are retained
**Automation:** node:test — [packages/core/src/notes/noteValidation.test.ts:48](../../packages/core/src/notes/noteValidation.test.ts#L48)

**Given:** note create/update inputs at configured title and body limits.
**When:** boundary, blank, non-string, Unicode and whitespace inputs are validated.
**Then:** titles trim; tested maximum lengths pass and excess lengths fail; empty/whitespace bodies are retained as asserted.

## PT-75D8223A74

**Title:** patches reject immutable or unknown fields and explicit undefined; group edits remain narrow
**Automation:** node:test — [packages/core/src/notes/noteValidation.test.ts:57](../../packages/core/src/notes/noteValidation.test.ts#L57)

**Given:** note and group patches and group-create inputs.
**When:** both update validators receive empty objects, or immutable/unknown fields, explicit undefined, invalid bodies or invalid member IDs are supplied.
**Then:** both empty patches return VALIDATION_ERROR with the root issue “At least one editable field is required.”; tested invalid fields fail with sanitized issues; title-only note/group edits trim titles; group edits reject memberships; empty group membership is accepted.

## PT-A5DB078E2D

**Title:** explicit project and entity scope produce typed transport-safe errors
**Automation:** node:test — [packages/core/src/notes/noteValidation.test.ts:77](../../packages/core/src/notes/noteValidation.test.ts#L77)

**Given:** a project registry and project-owned records.
**When:** project, entity and membership helpers resolve invalid, missing or foreign IDs and valid ordered membership.
**Then:** expected typed codes result; successful membership returns a detached array; the tested failure survives JSON round trip.
