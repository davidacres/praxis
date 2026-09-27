---
**Status:** ✅ Complete
**Created:** 2026-09-26T23:15:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-046
slug: easymode-sidebar-and-agent-activity
title: EasyMode sidebar, Agent Details page, and Simple theme
status: Complete
owner: Electron desktop app
updated: 2026-09-27
stories: [FX-BE-144, FX-BE-145, FX-BE-146]
---

# FX-BF-046: EasyMode sidebar, Agent Details page, and Simple theme

## Outcome

An experimental **EasyMode** sidebar for the Praxis desktop app, inspired by modern agent development environments like [Orca](https://www.onorca.dev/), alongside a new built-in **Simple** dark theme that matches Orca's minimalist, high-contrast aesthetic.

When enabled via an experimental preview toggle in Settings (`settings.preview.enableEasyMode`), EasyMode replaces the standard multi-level sidebar trees (Projects, Boards, WorkMode, horizontal splitter, and the Praxis footer panel) with a full-height, dedicated workspace panel with two primary sections:
1. **Sessions**: Displays each agent session as a structured card. When running, the session card displays its executing agents or subagents as sub-items with rich status indicators: solid red for failed, solid green for success, and a glowing breathing pulse animation while in-progress. Selecting a session container highlights the entire session card with a highlight border, slightly rounded corners, and a 20% opaque white background.
2. **Automations**: Displays workflow runs, with a header action to create and launch new workflow runs.
3. **Dedicated Agent Details Center Page**: Clicking an individual agent sub-item navigates the center pane to a new, focused page showing that specific agent's live activity stream, tool runs, file edits, thinking/reasoning blocks, and metrics.
4. **Simple Dark Theme**: A clean, minimalist dark theme featuring deep neutral charcoals (`#0a0a0a` canvas, `#171717` panels, `#030303` sunken), crisp white typography (`#fafafa`), subtle translucent borders, and pure white accents.

This feature is completely isolated behind `settings.preview.enableEasyMode`, ensuring zero side-effects or regressions when disabled.

## Decisions

1. **Gate behind an experimental preview setting (`settings.preview.enableEasyMode`).**
   - Stored in core's `PreviewSettings` interface (`packages/core/src/config/appSettings.ts`) with a default of `false`.
   - Mirrored in `apps/praxis-desktop/renderer/src/settings/settingsDefaults.ts` per Praxis monorepo rules.
   - Surfaced as a clean toggle in `SettingsPage.tsx` under the Preview/Experiments section.
   - When disabled (the default), `Sidebar.tsx` and the app shell remain 100% byte-for-byte unaffected.

2. **Full-area sidebar replacement when EasyMode is active.**
   - Rather than cramming new tabs into the existing sidebar or nesting under the Praxis footer, EasyMode renders `<EasyModeSidebar />` taking the full height of `.pane-sidebar`.
   - The standard sidebar controls (Projects tree, external Boards list, WorkModeView, horizontal splitter, and bottom footer panel with Overview/Conversations/Sessions/Connections/Agents) are completely suppressed while EasyMode is enabled.

3. **Consistent section header pattern across all sections.**
   - Every section in the EasyMode panel shares the exact same header structure:
     - Left-aligned section title text (`Sessions`, `Automations`) with clean typography.
     - Right-aligned `+` button on the exact same row: `<Icon name="plus" size={13} />`.
     - Standard accessible tooltips via `aria-label` promoted to `title`.

4. **Card-based session hierarchy with subagent items (Orca pattern).**
   - Each session is rendered as a distinct card (`.easymode-session-card`).
   - Running agents within a session are extracted via `extractSubagents` (child sessions linked by `parentSessionKey` + tool-invoked subagents from events). If no subagents exist, the primary agent is rendered.
   - Status indicators:
     - Failed: solid red (`--tone-failed: #ef4444`).
     - Success: solid green (`--tone-done: #10b981`).
     - In-progress: breathing pulse glow animation (`@keyframes easymode-glow`) using `--accent` and `--accent-soft`, with `@media (prefers-reduced-motion: reduce)` fallbacks.
   - Selection state: When a session is selected, the entire container wrapping the session and its sub-agents is highlighted with a highlight border (`border-color: var(--accent-border)`), slightly rounded corners (`border-radius: var(--radius-sm, 6px)`), and a 20% opaque white background (`background: color-mix(in srgb, #ffffff 20%, transparent)`).

5. **Dedicated Agent Details center page (`AgentActivityPage.tsx`).**
   - Currently, selecting a session opens `SessionsPage` (full chat console) and selecting an agent from Agent Hub opens `AgentDetailPage` (agent catalog/profile).
   - EasyMode introduces an activity-focused center page when an agent is clicked, rendering:
     - Header: Agent role/title, session link, model, live state badge, tokens, cost, duration.
     - Activity Feed: Chronological timeline of tool executions, arguments, output payloads, file edits (with diffs and one-click undo), thinking/reasoning, and diagnostics.

6. **Built-in `simple` theme inspired by `onorca.dev`.**
   - Added to `BUILT_IN_THEMES` in `themes.ts` and registered in core and renderer defaults.
   - Color palette: `#0a0a0a` canvas, `#171717` panels, `#030303` sunken, `#fafafa` text, `#ffffff` accent, `rgba(255, 255, 255, 0.08)` borders.
   - Tokens mapped in `theme.css` under `:root[data-theme='simple']`.

7. **Strict Praxis architectural compliance.**
   - No value imports from `@praxis/core` in the renderer (`import type` only, verified by `npm run check-core-imports`).
   - Inset floating card (`--pane-main-inset: 4px`) preserved.
   - All colors tokenized; no native OS alerts or prompts.

## Scope

- **Core configuration**: `enableEasyMode` field in `PreviewSettings`, sanitizer, mergers, unit tests.
- **Theme addition**: `simple` theme definition in `themes.ts`, token block in `theme.css`, `installedThemeIds` inclusion.
- **Settings UI**: Toggle in `SettingsPage.tsx` under Preview/Experiments.
- **EasyMode Sidebar**: New component `EasyModeSidebar.tsx` with standard section header pattern (`+` button), Sessions section with card selection highlight and glowing status dots, and Automations section with workflow run creation.
- **Agent Details Center Page**: New component `AgentActivityPage.tsx` with tool execution details, file diffs, undo, and reasoning.
- **Routing & Shell**: Route extension in `App.tsx` (`view: 'agent-details'`) and conditional sidebar rendering.
- **E2E verification**: Focused Playwright tests verifying the setting, sidebar replacement, glow animation, card highlight, agent selection, and theme switching.

## Out of scope

- Replacing standard Classic or Work sidebar modes permanently (EasyMode is opt-in).
- Modifying backend tracking or session storage schemas.
- Modifying mobile client sidebar rendering.

## Story map

| Ref | Story | Status | Depends on |
| --- | --- | --- | --- |
| FX-BE-144 | EasyMode sidebar workspace (Sessions, Automations, and Orca card hierarchy) | Complete | — |
| FX-BE-145 | Dedicated Agent Details center page (Activity feed, tool executions, and file edits) | Complete | FX-BE-144 |
| FX-BE-146 | Simple dark theme and preview setting | Complete | — |

## Dependencies

- `FX-BF-013` — workflow orchestration runtime (workflow runs listed in Automations).
- `FX-BF-042` — chat turn telemetry and live AI activity (event data reused in Agent Details).
- `FX-BF-045` — standalone conversations and session classification predicates.

## Risks or open questions

- **Glow animation performance**: Keyframe animations must be hardware-accelerated (`transform`, `opacity`, `box-shadow`) and respect `@media (prefers-reduced-motion: reduce)`.
- **Contrast in Light Mode**: While the `simple` theme is dark, EasyMode can run under any theme (e.g. `praxis-light`). Card background uses `color-mix(in srgb, #ffffff 20%, transparent)` in dark palettes and `color-mix(in srgb, var(--accent) 12%, var(--bg-elevated))` in light mode to maintain WCAG AA contrast.

## Close when

A user can enable EasyMode in Settings -> Preview, immediately seeing the streamlined sidebar panel. The Sessions section shows cards with red/green/glowing status indicators for running agents; selecting a session card highlights it with a border, rounded corners, and a 20% white background. Clicking an agent opens the dedicated Agent Details center page displaying its live tool runs and activity. The Automations section lists workflow runs and allows creating new runs via `+`. The user can also switch to the `simple` dark theme to get the full Orca-inspired aesthetic. All existing e2e tests continue to pass with EasyMode off.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-144 | Story | EasyMode sidebar workspace (Sessions, Automations, and Orca card hierarchy) | Complete |
| FX-BE-145 | Story | Dedicated Agent Details center page (Activity feed, tool executions, and file edits) | Complete |
| FX-BE-146 | Story | Simple dark theme and preview setting | Complete |
| TASK-375 | Task | Define enableEasyMode setting contract, sanitizer, and renderer defaults | Complete |
| TASK-376 | Task | Register Simple dark theme, CSS theme definition, and Settings Preview toggle | Complete |
| TASK-377 | Task | Create EasyModeSidebar host container and reusable SectionHeader component | Complete |
| TASK-378 | Task | Implement EasyMode Sessions card list, subagents hierarchy, status glow, and selection highlight | Complete |
| TASK-379 | Task | Implement EasyMode Automations section with workflow run triggers and dialog | Complete |
| TASK-380 | Task | Create Agent Details route integration, top bar, and center pane shell | Complete |
| TASK-381 | Task | Implement Agent Activity timeline, live events, tool args, file diffs, and undo action | Complete |
| TASK-382 | Task | End-to-end verification, accessibility audit, and visual snapshot testing | Complete |


## Comments

Delivered all stories (FX-BE-144, FX-BE-145, FX-BE-146) and all underlying tasks (TASK-375 through TASK-382). Implemented experimental EasyMode sidebar gated cleanly behind `settings.preview.enableEasyMode`, the Orca-inspired `simple` dark theme, the card-based Sessions list with glowing status dots for running subagents and 20% white selection highlights, the Automations workflow list with run creation, and the dedicated Agent Details center page featuring telemetry, live event timeline, collapsible tool execution cards with diff views, and undo capabilities. Verified with unit tests (`test:core`, 1,321 passing), Playwright e2e (`easymode.spec.ts`, 3 passing), renderer build, and strict core-import boundaries.
