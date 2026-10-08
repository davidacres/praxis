---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** Medium
id: TASK-421
slug: npm-audit-security-adapter
title: Parse npm audit output into security gate findings
status: Backlog
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 161
---

# TASK-421: Parse npm audit output into security gate findings

## Description

The Security scan check passes or fails on `npm audit`'s exit code only, so the security gate never sees structured findings. Add a `checkResultAdapters` adapter for `npm audit --json` and wire it to the template's security check, keeping the registry flag the template already needs.

## Acceptance criteria

- The adapter turns advisories into findings with stable fingerprints, severity mapped from npm's levels, file set to the package manifest, and a suggestion naming the fixed version where npm reports one.
- Malformed or empty output raises `CheckResultParseError`, never an empty findings list that passes (the adapters' stated rule).
- A fixture of real `npm audit --json` output (clean, vulnerable, and the no-audit-endpoint failure that `checkEnvironmentFailure` already classifies) is covered.
- The security output kind changes from `report` to `findings` and the Approve threshold for `security` is added; the environment-failure pause behaviour is unchanged.

## Dependencies

- TASK-420

## Comments
