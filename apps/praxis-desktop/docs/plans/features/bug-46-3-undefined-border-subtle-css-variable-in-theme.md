---
**Status:** Backlog
**Created:** 2026-10-08T18:35:00.000Z
**Type:** Bug
**Priority:** Low
**Severity:** Low
**Reported By:** Dave Acres
id: FX-BG-048
title: Undefined --border-subtle CSS variable used across desktop stylesheets
status: Backlog
updated: 2026-10-08
---

# [P3] Undefined --border-subtle CSS variable used across desktop stylesheets

## Description

The CSS variable `--border-subtle` is referenced 22 times across `apps/praxis-desktop/renderer/src/theme.css`, but is never defined on `:root` or any `[data-mode]` theme selector. In several instances (e.g. `.easymode-section--runs`, `.usage-model-row`, `.overview-list-row`, `.wf-timeline-attempt-badge`), the variable is referenced without a fallback (`var(--border-subtle)`), causing borders to fall back to browser default/transparent styling rather than matching the design system's border tokens.

**Expected behaviour**

`--border-subtle` is declared in the base theme tokens on `:root` and adapted per color mode (`light` and `dark`), or replaced with the existing token `--border`.

**Acceptance criteria**

- [ ] `--border-subtle` is formally defined in `:root` and `[data-mode]` blocks in `theme.css`, or replaced with valid design tokens.
- [ ] No occurrences of `var(--border-subtle)` remain unresolvable.
- [ ] Borders in EasyMode sidebar (`.easymode-section--runs`), usage overview, and workflow timeline render with consistent themed subtlety.

## Investigation state

- **Confirmed in `apps/praxis-desktop/renderer/src/theme.css`:**
  - Lines using `var(--border-subtle)` with no fallback include:
    - line 5197 (`.usage-model-row`)
    - line 5225 (`.overview-list-row`)
    - line 5242 (`.overview-activity-row`)
    - line 5252 (`.overview-health-row`)
    - line 5255 (`.overview-health-card`)
    - line 5365 (`.ContributionCalendar-footer`)
    - line 14034 (`.wf-timeline-controls`)
    - line 14037 (`.wf-timeline-attempt-badge`)
    - line 14038 (`.wf-timeline-earlier`)
    - line 19498 (`.easymode-section--runs`)
  - A grep for `--border-subtle:` across all CSS files returns 0 definitions.

## Steps to Reproduce

1. Inspect elements with class `.easymode-section--runs` or `.wf-timeline-attempt-badge` in Developer Tools.
2. Check computed styles for `border-top` / `border`.
3. Notice `var(--border-subtle)` resolves to an undefined property value.

## Expected Behavior

All theme border variables resolve to coherent design system colors.

## Actual Behavior

`--border-subtle` is undefined, resulting in missing or default browser fallback borders.

## Dependencies

None.

## Comments


