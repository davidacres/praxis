---
**Created:** 2026-10-24T10:52:31.834Z
id: FX-BF-110
type: Feature
status: Backlog
updated: 2026-10-24
---

# Sidebar parity and Easy Mode conversation organization

**Type:** Feature
**Status:** 📋 To Do
**Priority:** P2

## Outcome

Keep Classic and Easy Mode as useful layout choices while closing Easy Mode's conversation organization gaps: persistent drag ordering, named groups, assignment of chats to projects, and explainable next-ticket suggestions from recent work. This is an implementation-ready plan, not implementation approval or a claim that these capabilities exist.

## Current comparison and ratings

Source review on 2026-10-24; scores are subjective capability/discoverability assessments (1 = minimal, 3 = usable/partial, 5 = strong), not live usability test results. No overall winner is implied.

| Feature | Classic | Easy Mode | Current evidence and difference |
| --- | --- | --- | --- |
| Session card status, activity and gates | ★★★★★ | ★★★★★ | Shared card classes, SessionCardActivity, StatusGlyph and provider/model presentation; keep parity. |
| Project focus and switching | ★★★★☆ | ★★★★☆ | App supplies focusedProjectId to Classic and easyModeProject to Easy; workspace project picker drives focus. Classic can render multiple projects when no focus is supplied. |
| Git status at a glance | ★★★☆☆ | ★★★★☆ | Easy Horizon shows branch/dirty/ahead/behind; it fetches on workspaceFolder or sessions.length changes, not continuous polling. Classic supplies direct Git navigation. |
| Broad project navigation | ★★★★★ | ★★★☆☆ | Classic has board/docs/repository/services/workflow tree; Easy emphasizes Sessions and Runs. Whole-app access must be assessed separately from sidebar shortcuts. |
| Run expansion and stage navigation | ★★★★★ | ★★★★★ | Both offer inline workflow progress and stage-session navigation. |
| Session search and folding | ★★★★☆ | ★★★★☆ | Easy searches title/model and folds the finished tail while keeping attention/selected rows. Classic has broader sidebar/session controls; search semantics differ. |
| Manual ordering and named groups | ★★★★☆ | ★☆☆☆☆ | Classic wraps feeds in SessionOrganizer, with persisted drag layout; Easy maps cards directly with no organizer. Classic recency buckets constrain scope. |
| Assign AI conversation to project/ticket | ★★★★☆ | ★★★☆☆ | Both expose AssignSessionDialog and assignment callbacks; Classic also accepts conversation drops on project nodes. Easy has no project drop target. |
| Persisted team chats in project feed | ★★★★☆ | ★☆☆☆☆ | Classic ProjectRecencyFeed includes TeamChatRow; Easy list currently accepts AgentSessionRecord only. Team-chat reassignment requires separate store/API work. |
| Compactness and immediate session focus | ★★★★☆ | ★★★★★ | Easy uses compact Horizon, Sessions and Runs sections. Scores describe design intent; validate visually before treating this as measured usability. |

## Recommendations and priority

1. P1: close Easy's drag ordering, grouping and project assignment gaps; keep its compact layout. Preserve Classic's broader navigation.
2. Reuse SessionOrganizer and assignment validation; share behavior in renderer modules instead of maintaining two drag implementations. Keep layout-specific headers and navigation.
3. Use stable project-scoped Easy layout state, independent of recency buckets. Keep Classic saved layout keys compatible; avoid an automatic cross-mode migration that could lose groups.
4. Treat manual order as authoritative once customized. Search is a projection: disable reorder/group edits during an active search, preserve full saved membership, and expose the unfiltered list while organizing. Hidden/archived IDs must not be erased by rendering a subset.
5. Keep attention discoverable: selected/live/waiting items remain visible or have an obvious group summary and jump action. Preserve existing status semantics, including background work.
6. Make ownership explicit: show eligible workspace project targets during a drag and retain the Assign to project menu/dialog. An assignment must never happen as a side effect of local reordering.
7. Cover both root AI conversations and persisted team chats. Reuse the AI assignment API for sessions; add a separate typed operation for team chats only after inspecting their store and IPC contracts.
8. P2: add a single-ticket suggestion panel immediately above Runs, with previous/next controls, a relevance reason and explicit ticket navigation. Start with bounded deterministic ranking from recent project sessions/work; avoid model calls and automatic execution. See FX-BE-178.
9. P2 follow-up, outside this feature: improve Git freshness with a bounded refresh/subscription and consider optional compact board/Git/docs shortcuts based on usage evidence. Do not describe the current Horizon as continuously live.

## Scope and interaction contract

- Flat named groups: create by center drop; before/after zones reorder; drop on a group joins it; explicit ungroup target removes membership. Support group rename, collapse, moving and dissolve without deleting conversations.
- Dedicated drag handle with visible insert/join indicators and cancellation. Menu/keyboard alternatives cover reorder, grouping and project assignment. Dragging must not trigger card actions.
- Project tray appears for eligible conversation ownership drags and exposes other workspace projects despite single-project focus. Reject stale/foreign targets. Existing assignment dialog remains available without dragging.
- Local layout actions never alter project/ticket identity, workspaceFolder, parentSessionKey or workflowRunId. Project assignment follows existing eligibility and ticket validation and updates layout only after success.
- Workflow runs remain in Runs; subagents/stage sessions stay under their parent. No arbitrary run/stage ownership moves or nesting groups.
- Plan-only delivery here: no runtime edits, settings changes, automatic layout migration, external tracker publishing or mode removal.

## Architecture and implementation order

1. Inspect and specify App.tsx routing/scoping, Sidebar.tsx feed behavior, SessionOrganizer.tsx persistence and both drag MIME paths (`application/x-praxis-session-order` and `application/x-praxis-conversation`). Distinguish local layout and ownership intent in one drag without competing nested handlers.
2. Adapt the renderer organizer for stable project identity, explicit handles and accessible actions; wire EasyModeSessionsList/EasyModeSessionCard. Treat project changes as keyed/remounted state or explicitly reload persistence; use stable entity IDs, never list indices or titles.
3. Wire EasyModeSidebar project targets through existing App assignment callbacks and AssignSessionDialog. Maintain one ownership mutation per drop, visible errors and consistent active navigation.
4. Inspect assistant/TeamChatRow.tsx, AssistantProvider, core TeamChatStore and assistant IPC contracts. Add team-chat listing and durable reassignment with separate typed payloads; never reinterpret a team-chat ID as a session key. Read AI area notes before touching runtime contracts.
5. Add project-scoped ticket ranking and the floating suggestion card described in FX-BE-178, before the Runs section.
6. Verify persistence, filtering, eligibility, failures and live pointer behavior in both modes. Renderer uses core types only; appearance uses existing theme tokens and controls.

## Story map

- [FX-BE-174 — Define sidebar parity and shared organization behavior](stories/fx-be-174-shared-sidebar-behavior/story.md)
- [FX-BE-175 — Add Easy Mode drag ordering and named groups](stories/fx-be-175-easy-mode-drag-order-and-groups/story.md)
- [FX-BE-176 — Assign chats to projects from Easy Mode](stories/fx-be-176-chat-project-assignment/story.md)
- [FX-BE-177 — Verify both sidebar modes and retain interaction evidence](stories/fx-be-177-sidebar-parity-verification/story.md)

- [FX-BE-178 — Suggest the next ticket from recent work in Easy Mode](stories/fx-be-178-easy-mode-ticket-suggestions/story.md)

## Dependencies

No blocking external dependency. Builds on existing Easy sidebar, Classic SessionOrganizer, AI assignment and team-chat persistence. Review current APIs before implementation; no dependency status is changed by this plan.

## Risks and decisions to preserve

- SessionOrganizer currently derives rendered entries from available nodes; persisting a filtered projection could lose hidden membership. Preserve full layout separately from visible rows.
- The current organizer initializes saved state once; changing scope without remount/reload risks project leakage.
- Classic groups may belong to a recency bucket. Reusing the component must not imply untested layout migration or cross-bucket moves.
- Team chats and AI sessions have different persistence/runtime ownership. Validate destination ticket compatibility and failure recovery explicitly; do not invent a generic mutation that bypasses existing rules.
- Running-session reassignment remains governed by current runtime validation; unsupported moves must explain the refusal and leave state untouched.

## Validation and close conditions

- Build core, renderer and desktop; run `npm run check-types` and `npm run desktop:copy-renderer` before e2e.
- Run focused `easymode.spec.ts`, `standaloneConversations.spec.ts`, `chatProjectAssignment.visual.spec.ts`, sidebar alignment and new organization coverage, then `npm run test:desktop`.
- Launch the actual app and verify mouse dragging, keyboard alternatives, project switching and restart persistence. Inspect actual/diff images before accepting snapshots; retain useful screenshots in `.praxis/session-artifacts/`.
- All fixtures and Praxis write paths use temporary directories; never point a fixture at this working tree.

Close only after every story's acceptance criteria are evidenced, no Classic regressions remain, ticket suggestions meet FX-BE-178 and remain explainable/project-scoped, both conversation types retain identity/transcripts after assignment, and ordering/grouping survives restart and project switching. This document's creation does not satisfy those implementation conditions.

## Planning file inventory and parser compliance

All canonical items and mirrors below declare unique canonical IDs, explicit types, Backlog status and an H1 title. Mirrors intentionally repeat the linked plan ID outside the parsed plans tree. Features use feature.md; stories use stories/<id>-<slug>/story.md; tasks explicitly declare Task. Dependencies are named in dedicated sections. Index files are navigation documents outside the parsed plans tree.

| File | ID | Type | Status | H1 |
| --- | --- | --- | --- | --- |
| [feature.md](feature.md) | FX-BF-110 | Feature | Backlog | Sidebar parity and Easy Mode conversation organization |
| [feature-issues.md](../../../issues/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/feature-issues.md) | FX-BF-110 | Feature mirror | Backlog | Sidebar parity and Easy Mode conversation organization |
| [story.md](stories/fx-be-174-shared-sidebar-behavior/story.md) | FX-BE-174 | Story | 📋 To Do | Define sidebar parity and shared organization behavior |
| [issue.md](../../../issues/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-174-shared-sidebar-behavior/issue.md) | FX-BE-174 | Story mirror | Backlog | Define sidebar parity and shared organization behavior |
| [task-467-sidebar-parity-contract.md](stories/fx-be-174-shared-sidebar-behavior/tasks/task-467-sidebar-parity-contract.md) | TASK-467 | Task | 📋 To Do | Document the parity contract and resolve organization semantics |
| [task-468-shared-organizer.md](stories/fx-be-174-shared-sidebar-behavior/tasks/task-468-shared-organizer.md) | TASK-468 | Task | 📋 To Do | Reuse the organizer with stable identity and mode compatibility |
| [story.md](stories/fx-be-175-easy-mode-drag-order-and-groups/story.md) | FX-BE-175 | Story | 📋 To Do | Add Easy Mode drag ordering and named groups |
| [issue.md](../../../issues/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-175-easy-mode-drag-order-and-groups/issue.md) | FX-BE-175 | Story mirror | Backlog | Add Easy Mode drag ordering and named groups |
| [task-469-easy-ordering.md](stories/fx-be-175-easy-mode-drag-order-and-groups/tasks/task-469-easy-ordering.md) | TASK-469 | Task | 📋 To Do | Add persistent Easy Mode ordering and predictable filtered views |
| [task-470-easy-groups.md](stories/fx-be-175-easy-mode-drag-order-and-groups/tasks/task-470-easy-groups.md) | TASK-470 | Task | 📋 To Do | Add named group lifecycle and accessible move operations |
| [story.md](stories/fx-be-176-chat-project-assignment/story.md) | FX-BE-176 | Story | 📋 To Do | Assign chats to projects from Easy Mode |
| [issue.md](../../../issues/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-176-chat-project-assignment/issue.md) | FX-BE-176 | Story mirror | Backlog | Assign chats to projects from Easy Mode |
| [task-471-session-project-drops.md](stories/fx-be-176-chat-project-assignment/tasks/task-471-session-project-drops.md) | TASK-471 | Task | 📋 To Do | Add validated project drop targets for AI conversations |
| [task-472-team-chat-assignment.md](stories/fx-be-176-chat-project-assignment/tasks/task-472-team-chat-assignment.md) | TASK-472 | Task | 📋 To Do | Include persisted team chats with explicit ownership semantics |
| [story.md](stories/fx-be-177-sidebar-parity-verification/story.md) | FX-BE-177 | Story | 📋 To Do | Verify both sidebar modes and retain interaction evidence |
| [issue.md](../../../issues/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-177-sidebar-parity-verification/issue.md) | FX-BE-177 | Story mirror | Backlog | Verify both sidebar modes and retain interaction evidence |
| [task-473-sidebar-verification.md](stories/fx-be-177-sidebar-parity-verification/tasks/task-473-sidebar-verification.md) | TASK-473 | Task | 📋 To Do | Prove organization and assignment in the loaded desktop app |

Updated indexes: `docs/PLAN_MAP.md` and `docs/issues/index.md` (navigation only; no planning ID/type/status/H1 contract applies).

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments



## Ticket suggestion planning inventory extension

All additions satisfy H1, explicit type, unique ID, Backlog status and dedicated dependency sections. Story links its issue mirror; tasks link their parent.

| File | ID | Type | Status | H1 |
| --- | --- | --- | --- | --- |
| [story.md](stories/fx-be-178-easy-mode-ticket-suggestions/story.md) | FX-BE-178 | Story | 📋 To Do | Suggest the next ticket from recent work in Easy Mode |
| [issue.md](../../../issues/features/fx-bf-110-sidebar-parity-and-easy-mode-organization/stories/fx-be-178-easy-mode-ticket-suggestions/issue.md) | FX-BE-178 | Story mirror | Backlog | Suggest the next ticket from recent work in Easy Mode |
| [task-474-rank-ticket-suggestions.md](stories/fx-be-178-easy-mode-ticket-suggestions/tasks/task-474-rank-ticket-suggestions.md) | TASK-474 | Task | 📋 To Do | Rank relevant tickets from recent project work |
| [task-475-ticket-suggestion-panel.md](stories/fx-be-178-easy-mode-ticket-suggestions/tasks/task-475-ticket-suggestion-panel.md) | TASK-475 | Task | 📋 To Do | Add the floating single-ticket suggestion panel |
