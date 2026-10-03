---
**Status:** ✅ Complete
**Created:** 2026-10-03T00:00:00.000Z
**Type:** Story
**Priority:** High
id: FX-BE-154
type: Story
status: Complete
created: 2026-10-03
owner: Electron desktop app
---

# Page context providers and interactive in-app actions

## Impact

The assistant becomes deeply aware of what the user is working on by subscribing to active page state across Kanban boards, ticket details, workflow designer, git diffs, and workflow runs. It can propose structured changes with 1-click apply and escalate complex coding requests directly to autonomous ACP agent sessions.

## Scope

- A unified React hook `useRegisterPageAssistantContext(...)` used by views to advertise their current context and action capabilities.
- Context injection for key Praxis surfaces:
  - **Board View:** Board name, columns, visible issues, active filters, column WIP counts.
  - **Issue Detail:** Ticket key, summary, description, acceptance criteria, comments, git branch.
  - **Git Changes / Graph:** Staged and unstaged diff summary, branch names, commit drafts.
  - **Workflow Runs:** Run status, active/failed stage, step logs, artifacts.
- Migration of the Workflow Designer:
  - Replaces `WorkflowAssistantPopover` on `WorkflowDesignerPage` with the global assistant.
  - Injects workflow definition and validation diagnostics into assistant context.
  - Supports proposing validated workflow edits.
- Interactive actions and ACP delegation:
  - 1-click **Apply** for proposed ticket edits, workflow changes, or new issue creation.
  - **"Open as Coding Session"** button: Pre-populates a new autonomous ACP session with the discussion history and requirements.

## Tasks

| Ref | Task | Status | Priority |
| --- | --- | --- | --- |
| TASK-407 | `usePageAssistantContext` hook and surface integrations for Board, Issue Detail, and Git | Complete | High |
| TASK-408 | Workflow Designer assistant migration to unified assistant with mutation action | Complete | Medium |
| TASK-409 | Interactive action proposals with 1-click apply and ACP coding session delegation | Complete | High |

## Dependencies

- `FX-BE-152` — Multi-persona team engine and assistant IPC.
- `FX-BE-153` — Dockable and floating assistant UI shell with multi-persona chat feed.

## Description


## Comments


