# [P3] Remove the npm install fallback from GitLab CI

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:57.273Z
**Type:** Task
**Priority:** Medium
**Parent:** PRX-F107

## Description
**Priority:** P3 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-016** (Low, CWE-1357) — `.gitlab-ci.yml:26` (`npm ci || npm install`).

## Why this priority

Low, one line, no user-facing risk — hardening backlog, but cheap enough that it should not sit indefinitely. `npm ci` installs exactly the lockfile; `npm install` is free to re-resolve every caret range, including the eight transitive packages the root `package.json` pins through `overrides`. The `||` means any transient failure — a checksum mismatch, a registry hiccup, a lockfile that drifted — silently downgrades the build to unpinned resolution, which is precisely the condition under which a compromised patch release would be pulled in and executed with whatever credentials the job holds.

## Change

`.gitlab-ci.yml:26` — replace `npm ci || npm install` with `npm ci` alone, and let the job fail loudly when the lockfile and manifest have drifted; that failure is the signal. If a fallback is genuinely wanted for a specific recoverable case, use `npm cache clean --force && npm ci` or `npm ci --prefer-offline`, never `npm install`.

## Verification

Confirm the pipeline still passes on a clean run. Then deliberately desynchronise `package.json` and `package-lock.json` on a scratch branch and confirm the job now fails instead of proceeding with re-resolved dependencies.

## Effort

S

## Depends on

None.

## Risk

Builds that were quietly surviving on the fallback start failing. That is the intended outcome, but expect at least one pipeline break where the lockfile has already drifted — fix the drift, do not restore the fallback.

## Dependencies


## Comments

