---
**Status:** Done
**Created:** 2026-10-08T18:35:00.000Z
**Type:** Bug
**Priority:** Medium
**Severity:** Medium
**Reported By:** Dave Acres
id: FX-BG-050
title: isAttentionState omits paused and not_started sessions in EasyModeSessionsList
status: Done
updated: 2026-10-11
---

# [P2] isAttentionState omits paused and not_started sessions in EasyModeSessionsList

## Description

In `apps/praxis-desktop/renderer/src/components/sidebar/EasyModeSessionsList.tsx`, the `isAttentionState` helper is intended to keep active/in-flight sessions always visible so that the 5-item collapse cap (`COLLAPSED_SESSION_LIMIT = 5`) only trims finished sessions.

However, `isAttentionState` only checks:
```ts
function isAttentionState(state: AgentSessionRecord['state']): boolean {
  return state === 'executing' || state === 'planning' || state === 'awaiting_approval' || state === 'awaiting_input';
}
```

The full `AgentTaskState` union is:
`'not_started' | 'planning' | 'awaiting_approval' | 'executing' | 'awaiting_input' | 'paused' | 'completed' | 'failed' | 'aborted'`

Because `paused` and `not_started` are omitted:
1. When an app shutdown or restart interrupts running sessions, `dispose()` transitions sessions to `paused` for restart recovery (`getInterruptedAgentSessions`). If there are 5 or more newer sessions, these paused sessions fold away into the hidden tail behind "Show more" instead of remaining visible for user action/recovery.
2. Sessions queued or pending start (`not_started`) similarly fold away as if they were finished.
3. The `filterTab === 'live'` filter also excludes `paused` and `not_started` sessions from the "live" tab.

**Expected behaviour**

Non-terminal sessions (such as `paused` and `not_started`) that require user intervention or are waiting to run should not be treated as finished tail items, and should stay visible above the "Show more" fold.

**Acceptance criteria**

- [x] `isAttentionState` (or a dedicated `isTerminalSessionState` predicate) accounts for `paused` and `not_started` sessions.
- [x] Both `paused` (including restart-interrupted) and `not_started` sessions remain visible beyond position 5 with Show more collapsed. Test each state separately.
- [x] Both states appear in the Live tab; completed, failed and aborted sessions retain the existing terminal-state filtering and collapse behavior.
- [x] Making either state visible does not start/resume a session or grant approval; recovery still requires the existing explicit user action.
- [x] Add focused e2e coverage for both states beyond position 5 and in the Live tab, run `npm run test:desktop` against the rebuilt/copied renderer, and visually inspect collapsed/expanded lists in the same build.

## Investigation state

- **Confirmed in `apps/praxis-desktop/renderer/src/components/sidebar/EasyModeSessionsList.tsx`:**
  - Lines 24-26:
    ```ts
    function isAttentionState(state: AgentSessionRecord['state']): boolean {
      return state === 'executing' || state === 'planning' || state === 'awaiting_approval' || state === 'awaiting_input';
    }
    ```
  - Lines 71-74:
    ```ts
    return filteredSessions.filter(
      (s, index) => index < COLLAPSED_SESSION_LIMIT || isAttentionState(s.state) || s.issueKey === selectedSessionKey
    );
    ```
  - Only `completed`, `failed`, and `aborted` are true terminal states. `paused` represents interrupted sessions awaiting resumption or recovery.

## Steps to Reproduce

1. Create or accumulate 6 agent sessions in Praxis Desktop.
2. Have the 6th session be in `paused` state (e.g. from an app quit or restart).
3. View the EasyMode sidebar without search or "Show more" expanded.

## Expected Behavior

The paused session remains visible because it is not finished and may require user attention/recovery.

## Actual Behavior

The paused session is treated as part of the finished tail and hidden behind "Show more (1)".

## Dependencies

None.

## Historical work order — 2026-10-11 (superseded by closeout below)

**3 of 5** in the reviewed ticket set, after PRX-B00-2. Ready for a bounded session visibility fix. No direct security vulnerability identified; preserve explicit recovery and permission controls.

## Comments



### 2026-10-11 — closeout status and verification

Existing full-run log records the paused/not_started visibility test in `easymode.spec.ts` passing in both All and Live beyond the first five entries. Retained visual evidence: `.praxis/session-artifacts/easymode-unfinished-live.png`.

The existing detached run (`/tmp/sd3-full.log`) finished: **590 passed, 3 skipped, 1 failed**. These are prior-run results, not a new run. E2E tests were not run during this closeout, as requested.
