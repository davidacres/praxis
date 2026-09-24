# [P0] Pass github.ref_name through the environment and scope the release workflow token

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:52.282Z
**Type:** Bug
**Priority:** Medium
**Severity:** Medium
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P0 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-010** (Medium, CWE-78 / CWE-94) — `.github/workflows/build-release.yml:40-44` (macOS `gh release upload`) and `:77-81` (the identical PowerShell job).

## Why this priority

Medium by severity, P0 by exposure: this is the workflow that builds and uploads the DMG and NSIS installer users auto-update from, it declares **no** `permissions:` block at any level (unlike `build.yml`, which sets `contents: read` at line 12), and it puts `secrets.GITHUB_TOKEN` directly in the step environment. GitHub expands `${{ … }}` textually into the shell script before the shell runs, and `git check-ref-format` permits `;`, `|`, `&`, `$`, backtick and parentheses in a tag name. Anyone with write access — or anyone holding a stolen contributor credential — pushes a crafted tag and gets code execution in CI plus the ability to tamper with the artefact about to be published. Effort S: the largest risk reduction per hour in the set.

## Change

In `.github/workflows/build-release.yml`, for both upload steps:

- Move the interpolation into `env:` — `TAG: ${{ github.ref_name }}` alongside the existing `GITHUB_TOKEN` — and reference `"$TAG"` in the bash `run:` at `:40-44` and `"$env:TAG"` in the `shell: pwsh` step at `:77-81`.
- Add a top-level `permissions:` block granting only `contents: write` (what `gh release upload` needs). `build.yml:12-13` is the pattern to copy.
- Check `.github/workflows/publish-packages.yml` for the same interpolation pattern while you are in there.

## Change is config-only; no application code is touched.

## Verification

A repo check (or the existing Semgrep `run-shell-injection` rule, which currently flags exactly these two lines and must come back clean) asserting that no `${{ github.* }}` expression appears inside any `run:` block. Then push a tag containing shell metacharacters to a fork and confirm the upload step fails on a missing release rather than executing the substitution.

## Effort

S

## Depends on

None.

## Risk

PowerShell quoting differs from bash and the step uses backtick line continuations, which is exactly where this gets silently wrong — test the Windows job against a real tag, not just by reading it. Narrowing `permissions:` can break a step that quietly relied on a wider default scope (for example `packages: write` in `publish-packages.yml`); add scopes back one at a time and explicitly, rather than reverting to the default.

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

