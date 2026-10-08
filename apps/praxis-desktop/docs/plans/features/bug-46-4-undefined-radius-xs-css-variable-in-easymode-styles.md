---
**Status:** Backlog
**Created:** 2026-10-08T18:35:00.000Z
**Type:** Bug
**Priority:** Low
**Severity:** Low
**Reported By:** Dave Acres
id: FX-BG-049
title: Undefined --radius-xs CSS variable used in EasyMode styles
status: Backlog
updated: 2026-10-08
---

# [P3] Undefined --radius-xs CSS variable used in EasyMode styles

## Description

The CSS variable `--radius-xs` is used across EasyMode styles and workflow components (e.g. `.easymode-show-more` at line 19509, `.wf-timeline-attempt-badge` at line 14037, and lines 17130, 17183, 17270, 17371, 17510, etc.), but `--radius-xs` is never defined in the `:root` design tokens. `:root` only defines `--radius-sm` (4px), `--radius-md` (6px), `--radius-lg` (10px), `--radius-xl` (14px), and `--radius-pill`.

While some usages provide a hardcoded fallback (`var(--radius-xs, 4px)`), others like line 14037 (`border-radius: var(--radius-xs);`) have no fallback, resulting in square corners where rounded corners were intended. Furthermore, hardcoded pixel fallbacks do not respect `--ui-scale` scaling when large display size is active.

**Expected behaviour**

`--radius-xs` is defined in `:root` alongside `--radius-sm` (scaled with `var(--ui-scale)`), or replaced with the canonical `--radius-sm` token.

**Acceptance criteria**

- [ ] `--radius-xs` is declared on `:root` (e.g. `calc(3px * var(--ui-scale))` or aligned with design guidelines) or normalized to an existing radius token.
- [ ] No usages of `var(--radius-xs)` fail to resolve.
- [ ] Controls using the token scale properly under `[data-display-size='large']`.

## Investigation state

- **Confirmed in `apps/praxis-desktop/renderer/src/theme.css`:**
  - Token block on `:root` (lines 18-22):
    ```css
    --radius-sm: calc(4px * var(--ui-scale));
    --radius-md: calc(6px * var(--ui-scale));
    --radius-lg: calc(10px * var(--ui-scale));
    --radius-xl: calc(14px * var(--ui-scale));
    --radius-pill: 999px;
    ```
    No `--radius-xs` exists.
  - Usages without fallback:
    - line 14037: `.wf-timeline-attempt-badge { ... border-radius: var(--radius-xs); ... }`
  - Usages with inconsistent literal fallback:
    - line 12318: `var(--radius-xs, 3px)`
    - line 18140: `var(--radius-xs, 3px)`
    - line 19509: `var(--radius-xs, 4px)`

## Steps to Reproduce

1. Inspect `.wf-timeline-attempt-badge` or `.easymode-show-more` in DevTools.
2. Check computed `border-radius`.
3. Switch display size to large and observe lack of UI scale responsiveness where literal fallbacks are used.

## Expected Behavior

Radius tokens are consistently declared and respond to display scale settings.

## Actual Behavior

`--radius-xs` is not declared in design tokens.

## Dependencies

None.

## Comments


