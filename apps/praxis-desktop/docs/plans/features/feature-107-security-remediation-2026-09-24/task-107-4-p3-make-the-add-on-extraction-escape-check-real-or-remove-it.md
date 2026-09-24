# [P3] Make the add-on extraction escape check real, or remove it

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:56.900Z
**Type:** Task
**Priority:** Low
**Parent:** PRX-F107

## Description
**Priority:** P3 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-017** (Low, CWE-22 — ineffective compensating control) — `apps/praxis-desktop/main/src/main/adapters/electronAddonStorage.ts:160-166`, with `walk` at `:169-186`.

## Why this priority

Not exploitable today, so hardening backlog. `tar` 7.5.22 (confirmed in both lockfiles) strips absolute paths, rejects `..` segments and refuses to write through symlinks, and the `filter` correctly restricts entries to `package/addon/`. The defect is false assurance: `walk` enumerates via `fs.readdir` starting *at* `resolvedDest`, so every path it yields is under `resolvedDest` by construction and `path.resolve(resolvedDest, relative).startsWith(resolvedDest + sep)` is always true. The condition can never fire, it cannot see a file written outside the directory, and it does not resolve symlinks — while its test passes and a reader believes a second line of defence exists.

## Change

In `apps/praxis-desktop/main/src/main/adapters/electronAddonStorage.ts`, choose one:

- **(a) Delete it.** Remove the post-extraction loop and the `walk` helper, replacing them with a comment stating that containment is `tar`'s documented guarantee, and pin the minimum `tar` version.
- **(b) Make it real.** Validate each archive-declared entry path inside the existing `filter`/`onentry` callback, where the declared name is still visible, and `lstat` every extracted entry afterwards, rejecting symlinks and hard links.

## Verification

For (b): a test extracting a crafted tarball containing a `../` entry, and another containing a symlink entry, asserting extraction fails in both cases. For (a): the same crafted tarballs, asserting `tar` itself rejects them — so the guarantee being relied on is pinned by a test rather than by a comment that can go stale.

## Effort

S

## Depends on

None.

## Risk

Option (b) adds an `lstat` pass proportional to archive size on every add-on install. Option (a) removes a control on the strength of a dependency's documented behaviour, which makes the version pin and its test the thing that must never be quietly dropped in a future dependency bump.

## Dependencies


## Comments

