# [P3] Write the secrets file with mode 0600 and repair permissive files on read

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:57.642Z
**Type:** Task
**Priority:** Low
**Parent:** PRX-F107

## Description
**Priority:** P3 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-019** (Info, CWE-732) — `apps/praxis-desktop/main/src/main/adapters/electronSecretsStore.ts:46-49` (`writeAll`).

## Why this priority

Info, and genuinely defence-in-depth: the stored values are `safeStorage`-encrypted and the macOS container directory is normally `0700`. It is on the list at all because this single file consolidates every AI provider key, every tracker credential, every MCP OAuth token and the marketplace PAT, and a directory-permission assumption is thin for that to rest on. The fix is two lines, so it can ride along with any release.

## Change

In `apps/praxis-desktop/main/src/main/adapters/electronSecretsStore.ts`:

- Pass `{ mode: 0o600 }` to `fs.promises.writeFile` in `writeAll` (currently called with no `mode`, so the file lands at `0o666 & ~umask` — typically `0644`, world-readable).
- Pass `{ mode: 0o700, recursive: true }` to the `mkdir` that creates the containing directory.
- In `readAll`, `fs.chmod` the file back to `0600` when a stat shows it more permissive, so profiles written by older builds are repaired rather than left open.

If a Linux target is ever added (`main/package.json`'s `build` block currently targets DMG and NSIS only), also call `safeStorage.getSelectedStorageBackend()` at startup and refuse to store secrets under `basic_text` — see the report's Needs-verification #2.

## Verification

A test that writes a secret and asserts the resulting file's mode is `0600`, and that a file pre-created `0644` is repaired to `0600` on the next read. POSIX only — gate the assertion on `process.platform !== 'win32'`.

## Effort

S

## Depends on

None.

## Risk

Minimal. Windows does not honour POSIX modes, so the test must be platform-gated or it fails there. A `chmod` on a file owned by another user throws — swallow that error rather than letting it break secret loading at startup.

## Dependencies


## Comments

