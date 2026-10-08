---
**Status:** 📋 Proposed
**Created:** 2026-10-08T00:00:00.000Z
**Type:** Task
**Priority:** High
id: TASK-433
slug: protect-tests-from-improve
title: Protect tests from the improve stage
status: Backlog
created: 2026-10-08
owner: Electron desktop app
featureId: 108
storyId: 166
---

# TASK-433: Protect tests from the improve stage

## Description

Detect and fail an Improve pass that weakens the tests guarding it, so a loop cannot reach its target by editing the check.

## Acceptance criteria

- The verify step compares the iteration's diff against test paths (configurable globs with a sensible default) and fails the iteration when tests are edited, unless the stage explicitly declares tests in scope.
- Deleted or skipped tests (removed assertions, `.skip`, `xit`, lowered thresholds) are flagged even when the file is in scope, and shown in the iteration's findings.
- The failure message tells the improver which paths were touched; it does not tell it how to evade the rule.
- Tests cover an added test (allowed), a weakened assertion, a deleted test and a changed coverage threshold.

## Dependencies

- TASK-432

## Comments
