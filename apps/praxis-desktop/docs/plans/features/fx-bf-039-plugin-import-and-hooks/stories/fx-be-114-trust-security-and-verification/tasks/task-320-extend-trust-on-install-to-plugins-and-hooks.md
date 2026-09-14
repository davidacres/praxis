---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Task
**Priority:** Critical
type: Task
id: TASK-320
title: "Extend trust-on-install to imported plugins and hook scripts"
status: Proposed
story: FX-BE-114
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-114, TASK-313, TASK-316, TASK-318, TASK-319, TASK-309]
---

# TASK-320: Extend trust-on-install to imported plugins and hook scripts

## Objective

Route every imported plugin's install (and every re-install triggered by an update
that changes executable content) through FX-BF-018's existing trust gate, with a
hook script treated as at least as sensitive as an installed agent, and always
backed by TASK-313's real diff view rather than a bare re-confirm.

## Implementation notes

- Reuse FX-BF-018's trust store and UI copy rather than a second "trust this
  plugin" concept the user has to learn separately.
- A hook script (TASK-315's action execution, TASK-318's passthrough target, and
  TASK-316's user-built script action) must not run before the plugin/hook that
  owns it is explicitly trusted — this applies even under Claude Code passthrough,
  where Praxis is handing the script to another process rather than running it
  directly; the hand-off itself is gated.
- An `.mcp.json` server whose `url`/`command` changes on update is a new trust
  decision, not a silent carry-forward of the previous grant (per TASK-309) — the
  same applies to a hook script whose content hash changes. Both route through
  TASK-313's diff view, not a plain yes/no.
- A plugin installed but not yet trusted still shows in the Agent Hub with a clear
  "not trusted — nothing from this plugin runs yet" state, rather than being hidden
  or appearing indistinguishable from a trusted one.

## Acceptance criteria

- No plugin-provided code executes before an explicit trust grant, proven by test.
- A content change (hook script, MCP server target) on update shows the real diff
  and re-prompts, never a silent carry-forward.
- An untrusted, installed plugin is visibly distinct in the Agent Hub.
- Relevant documentation and plan references are updated.

## Verification

Run `npm run test:desktop` for the trust-gate e2e coverage and `npm run check-types`
across workspaces.

## Description


## Dependencies



## Comments
