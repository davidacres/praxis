---
**Status:** Backlog
**Created:** 2026-10-08T18:35:00.000Z
**Type:** Bug
**Priority:** Medium
**Severity:** Medium
**Reported By:** Dave Acres
id: FX-BG-047
title: EasyMode sidebar feed clips instead of scrolling at short window heights
status: Backlog
updated: 2026-10-08
---

# [P2] EasyMode sidebar feed clips instead of scrolling at short window heights

## Description

The EasyMode sidebar feed container (`.easymode-sidebar-feed`) overrides its base scrolling rule (`overflow-y: auto`) with `overflow: hidden`. In short windows or when vertical space is constrained, the combined minimum heights of the child sections (`.easymode-section--sessions` at `min-height: 140px` and `.easymode-section--runs` at `min-height: 72px`) exceed the container height. Because the feed cannot scroll, the Runs section is clipped and completely unreachable.

This regressed during the sidebar redesign in commit `6a26e5b2`.

**Expected behaviour**

The EasyMode sidebar feed maintains scrollability or flexible sizing so all sections (Sessions and Runs) remain accessible even when window height is small.

**Acceptance criteria**

- [ ] When the window or sidebar height is reduced below the combined height of sessions and runs sections, the feed either scrolls via `overflow-y: auto` or adapts so the Runs section is visible and interactive.
- [ ] The Sessions section internal scroll does not conflict with container scrolling when overflowing.
- [ ] Verified via e2e test or visual inspection at minimum supported desktop window heights.

## Investigation state

- **Confirmed in `apps/praxis-desktop/renderer/src/theme.css`:**
  - Base rule at line 17216:
    ```css
    .easymode-sidebar-feed {
      flex: 1;
      overflow-y: auto;
      padding: 10px 8px 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    ```
  - Redesign override block at line 19479:
    ```css
    .easymode-sidebar-feed {
      overflow: hidden;
      padding-bottom: 8px;
      gap: 8px;
    }
    .easymode-section--sessions {
      flex: 1 1 0;
      min-height: 140px;
    }
    .easymode-section--runs {
      flex: 0 1 auto;
      max-height: 45%;
      min-height: 72px;
      padding-top: 8px;
      border-top: 1px solid var(--border-subtle);
    }
    ```
  Setting `overflow: hidden` on `.easymode-sidebar-feed` causes content exceeding the available viewport height to be cut off with no scrollbar.

## Steps to Reproduce

1. Open Praxis Desktop in Easy Mode.
2. Resize the app window vertically to a compact/short height (e.g. 500px).
3. Observe the bottom of the sidebar.

## Expected Behavior

The Runs section remains visible, or the sidebar feed can be scrolled down to reach the Runs section.

## Actual Behavior

The feed clips its content due to `overflow: hidden`; the Runs section is partially or completely cut off and inaccessible.

## Dependencies

None.

## Comments


