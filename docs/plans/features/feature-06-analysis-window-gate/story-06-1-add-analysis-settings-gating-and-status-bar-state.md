# Story 06.1: Add Analysis Settings, Gating, And Status-Bar State

**Status:** Proposed
**Created:** 2026-05-20T00:00:00.000Z
**Type:** Story
**Priority:** P1
**Complexity:** Low
**Risk:** Low
**Confidence:** High
**Dependencies:** None

## Description
Add configuration and visibility gates for the analysis capability. Analysis should only be available when a default analysis prompt is configured, and the status bar must report enabled or disabled state.

## Implementation Activities
1. Add settings keys in package.json:
   - praxis.ai.analysisDefaultPrompt (required, empty default)
   - praxis.ai.analysisDefaultModel (optional, empty default)
2. Add AppConfigStore accessors in src/config/jiraConfig.ts:
   - getAiAnalysisDefaultPrompt()
   - getAiAnalysisDefaultModel()
   - isAiAnalysisEnabled()
3. Add and refresh context key praxis.analysisEnabled in src/extension.ts during activation and configuration changes.
4. Update menu when clauses to include praxis.analysisEnabled.
5. Extend src/views/praxisStatusBar.ts with analysisEnabled state and explicit copy:
   - Text suffix: Analysis enabled / Analysis disabled
   - Tooltip: Enabled (default prompt configured) or Disabled (set praxis.ai.analysisDefaultPrompt)

## Acceptance Criteria
1. Analysis commands and menu actions are hidden when analysisDefaultPrompt is empty.
2. Analysis commands and menu actions are visible when analysisDefaultPrompt is set.
3. Status bar shows Analysis disabled when prompt is missing.
4. Status bar shows Analysis enabled when prompt is configured.
5. Status bar updates without requiring VS Code restart.

## Verification
1. Clear praxis.ai.analysisDefaultPrompt and confirm action visibility is off.
2. Set praxis.ai.analysisDefaultPrompt and confirm action visibility is on.
3. Confirm status bar text/tooltip updates after each settings change.
4. Run npm run compile.

## Scoring Review (3 Passes)
1. Pass 1 (baseline): Complexity Low-Medium, Risk Low-Medium, Confidence Medium-High.
2. Pass 2 (after implementation-shape review): Complexity Low, Risk Low, Confidence High.
3. Rationale: Mostly settings/context/status-bar wiring with existing extension patterns and minimal behavioral surface area.
4. Pass 3 (after verification review): Complexity Low, Risk Low, Confidence High.
5. Rationale: Deterministic checks and no backend protocol changes keep failure modes narrow.

## Dependencies



## Comments


