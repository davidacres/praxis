---
**Status:** Backlog
**Created:** 2026-10-08T18:35:00.000Z
**Type:** Bug
**Priority:** Medium
**Severity:** Medium
**Reported By:** Dave Acres
id: FX-BG-050
title: isAttentionState omits paused and not_started sessions in EasyModeSessionsList
status: Backlog
updated: 2026-10-08
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

- [ ] `isAttentionState` (or a dedicated `isTerminalSessionState` predicate) accounts for `paused` and `not_started` sessions.
- [ ] Paused sessions (including those interrupted by app restart) remain visible in the EasyMode sessions list even when they sit beyond position 5 in the array.
- [ ] Unit or e2e test verifies that paused sessions do not collapse into the hidden tail.

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

## Comments


