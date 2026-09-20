# FX-BE-135 — Chat usability enhancements, tool execution summary, and message actions

**Type:** Story
**Status:** Complete
**Priority:** Medium
**Depends on:** FX-BE-134

## Business or operational impact

Enhances interaction feedback during multi-tool runs, bridges the chat thread with
the Activity inspector, and simplifies message content copying with accessible
hover actions.

## Scope

- Tool execution summary pill on assistant turns linking directly to Activity tab.
- Hover one-click copy button on message cards with visual confirmation.
- Theming and keyboard accessibility verification across all surface packs.

## Acceptance criteria

- Assistant turns running tools display a summary pill (e.g. `🛠️ Ran 2 tools · View in Activity`).
- Clicking switches to the Activity tab.
- Hovering message displays copy button; clicking writes markdown to clipboard.
- All styles respect theme variables and `:focus-visible` keyboard rings.

## Validation

- Renderer build and typecheck.
- Core-imports check.
- Cross-theme visual and accessibility testing.

## Close when

Tool pills, copy actions, and theme fidelity are verified and complete.
