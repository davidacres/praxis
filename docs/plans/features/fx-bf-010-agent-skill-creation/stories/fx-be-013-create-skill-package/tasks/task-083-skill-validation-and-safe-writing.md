---
**Status:** ✅ Complete
**Created:** 2026-08-31T12:27:31.993Z
**Type:** Task
**Priority:** Medium
id: TASK-083
title: Validate and safely write skill packages
status: complete
story: FX-BE-013
updated: 2026-08-31
dependencies: [TASK-082]
validation: [npm run test:core, npm run check-types]
---

# TASK-083: Validate and safely write skill packages

## Goal

Enforce skill metadata, duplicate, scope, and path safety before writing files.

## Done when

- Invalid packages are not partially written.
- User input cannot escape the selected root.
- Tests cover malformed front matter and unsafe names.

## Description


## Dependencies



## Comments


