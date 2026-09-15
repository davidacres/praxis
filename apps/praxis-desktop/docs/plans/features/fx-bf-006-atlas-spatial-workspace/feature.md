---
id: FX-BF-006
status: To Do
type: Feature
---

# FX-BF-006: Praxis Atlas — Explorable Spatial Workspace

**Type:** Feature
**Status:** 📋 To Do
**Owner:** Electron desktop app
**Priority:** Lowest
**Risk:** High
**Created:** 2026-08-27

## Outcome

Give Praxis a second primary way to see work: a single continuous 3D space that
represents the whole multi-project system and can be flown through — from every
project at once, down into one project's boards, into a board's tasks, and into
the AI sessions running on a task right now. Atlas is an exploratory and
situational-awareness surface. It never replaces the board or list views and it
is never the only way to complete an action.

The point Atlas has to earn: a person should be able to answer *"what is running,
what is blocked, and what should happen next"* across all their projects faster by
flying through Atlas than by clicking through the app. Every visual property in
the space maps to real data; nothing animates for decoration alone.

## Fit decision

Atlas belongs in `apps/praxis-desktop/renderer` (renderer) plus `packages/core` (shared
serializable contracts). `packages/core` owns the Atlas snapshot model and a
deterministic layout solver, with no dependency on Jira, GitLab, board UI state,
Git, or AI provider internals. The renderer owns the WebGL scene, camera, and
interaction. Electron main exposes only the typed IPC it already has for
projects, boards, issues, and agent sessions, plus a live event subscription;
Atlas adds no new privileged main-process capability.

The VS Code extension is not part of this delivery. A webview-hosted WebGL scene
of this size would duplicate rendering, camera, and performance behaviour for a
host that cannot give it the frame budget.

### Renderer stack

- `three`, `@react-three/fiber`, `@react-three/drei` for the declarative scene
  and camera rig.
- `@react-three/postprocessing` for bloom, depth of field, and vignette — the
  cues that make depth read as space rather than clip-art.
- `three-mesh-bvh` for raycast selection at scale.
- `troika-three-text` (via drei `<Text>`) for crisp SDF labels. Rich content
  stays in the DOM.

Adopting this stack is gated by `TASK-053`. If the spike cannot hold the frame
and accessibility budget on target hardware, the stack decision is revisited
before any production code lands.

## Scope

### First vertical slice — FX-BE-007

Thin at every scale rather than deep at one, because the novel risk is continuous
zoom across the hierarchy plus a live activity layer, not any single view.

1. A serializable Atlas snapshot in core: projects → boards → issues (with
   dependency links and status) → AI sessions (with lifecycle state).
2. A deterministic orbital layout solver in core: stable 3D positions per node,
   orbit radius from time horizon and priority, non-overlapping angular slots,
   computed per scale. Same input always produces the same map.
3. An `AtlasPage` WebGL scene with four level-of-detail tiers (universe, project,
   board, task), instanced distant bodies, full meshes near the camera, and a
   starfield.
4. A semantic-zoom camera that flies between focus targets along eased paths,
   with a breadcrumb trail, a back action, a snap-to-overview key, and an
   exit-to-app key.
5. Node visual encoding: shape = issue type, colour = status, idle spin rate =
   recency of activity, surface material = state. Blocked bodies are tethered to
   their blocker; ready-to-start bodies carry a halo. No signal is colour-only.
6. Selection via raycast opens the existing detail surface (issue detail or
   session view) as a DOM overlay; the scene keeps rendering behind it.
7. A live activity pass, overlaid at every tier: a running session shows motion
   and heat; a session waiting on user approval is a distinct, bright, actionable
   signal visible from the universe tier; a completing task snaps its dependents'
   tethers.
8. Navigation integration: an `atlas` route and sidebar entry, back/forward
   history compatibility, deep links to a specific focus target, and a one-key
   return to the board or list for the same context.

### Follow-on slices (proposed, not yet detailed)

- **FX-BE-008** — Full session drill-in: tool calls as pulses, diff output as
  trailing material, token burn as heat; failed and cancelled states;
  multi-session tasks.
- **FX-BE-009** — Layout persistence and manual arrangement: per-user saved
  positions as a reversible overlay, deterministic placement of new projects
  without reshuffling, and a "reset layout" action.
- **FX-BE-010** — Scale hardening and the galaxy tier: project health skybox,
  fast-travel command palette and search, load/unload of off-screen subtrees,
  and a documented performance fallback at large node counts.
- **FX-BE-011** — Accessibility completion: a DOM structural mirror of the
  current focus subtree, full keyboard navigation between bodies, and
  screen-reader labelling, with the board kept as the complete accessible path.

### Out of scope

Editing issues or sessions inside the 3D scene, VR/AR output, free-fly
first-person camera, multiplayer presence in the space, and any Atlas-only action
that cannot also be done from the board or list.

## Story map

- `FX-BE-007` — Atlas spatial shell and continuous zoom vertical slice. **Proposed.**
- `FX-BE-008` — Live session drill-in. **Proposed.**
- `FX-BE-009` — Layout persistence and manual arrangement. **Proposed.**
- `FX-BE-010` — Scale hardening and galaxy tier. **Proposed.**
- `FX-BE-011` — Accessibility completion. **Proposed.**

## Visual direction

One visual grammar repeated at every scale, so learning to read one tier means
being able to read them all:

- **Centre** = the container being viewed (workspace, project, board, or task).
- **Orbit radius** = time horizon and priority — active-now sits close, backlog
  sits far.
- **Body size** = scope.
- **Colour** = status, from a colour-blind-safe palette, never as the only signal.
- **Motion** = live activity — stale work is visibly still, active work moves.

| Tier | Centre | Orbiting bodies |
| --- | --- | --- |
| Universe | the workspace | projects as star systems |
| Project | the project core | boards as planets, plus a structural spine for Git |
| Board | the board star | epics as planets, stories as moons, tasks as satellites |
| Task | the task | its AI sessions as probes |

Motion budget: eased 150–250ms transitions on focus change, continuous idle spin
only where spin encodes recency, and a full stop under `prefers-reduced-motion` —
static camera, no idle motion, instant cuts. Post-processing is tuned for
legibility first; text never lives in a bloom path.

## Architecture

```text
Electron main (existing IPC): projects, boards, issues, agent sessions, live event stream
  -> preload: existing typed contracts + a live activity subscription
  -> packages/core: AtlasSnapshotBuilder (projects -> boards -> issues+links -> sessions, serializable)
  -> packages/core: AtlasLayoutSolver (deterministic 3D positions per tier, immutable output)
  -> apps/praxis-desktop/renderer: AtlasPage
       - scene graph (r3f/drei), starfield, LOD tiers
       - semantic-zoom camera rig (eased fly-to, breadcrumb, overview snap, exit)
       - node encoding + raycast selection (three-mesh-bvh)
       - live activity pass (subscription-driven, decoupled from layout)
       - DOM overlay for issue/session detail
```

Layout is recomputed from snapshots on a slow cadence and is pure. Activity is a
fast, separate pass driven by the live subscription and never mutates layout.
Selection and detail always resolve to the same DOM surfaces the rest of the app
uses — as of **FX-BF-008** those right-pane surfaces (project-details inspector,
ticket details) are borderless and inherit the active theme / surface pack, so
Atlas gets themed detail panes for free without an Atlas-specific style path.

## Data contracts

`AtlasSnapshot` holds `projects[]`, each with `boards[]`, each with `issues[]`
(id, type, status, priority, timeHorizon, dependency link ids), each with
`sessions[]` (id, lifecycle state, startedAt, lastActivityAt, awaitingApproval).
All ids are stable and serializable across the IPC boundary. `AtlasLayout` maps
each node id to an immutable position, orbit assignment, and tier. Same snapshot
in, same layout out.

## Delivery gates

1. Fit decision, visual contract, and renderer stack reviewed in this plan before
   implementation.
2. The `TASK-053` spike holds 60fps with a realistic node count on target
   hardware, proves camera limits, raycast selection, a DOM overlay, and a
   reduced-motion path, or the stack decision is revisited.
3. Core tests cover snapshot building and layout determinism, non-overlap, and
   stability when a project is added or removed.
4. Renderer tests cover focus navigation, selection, the live activity pass,
   empty/loading/error states, and reduced motion.
5. Core, Electron, and frontend type checks plus a focused Electron visual pass
   are green.
6. A documented usability check shows the three target questions are answerable
   faster in Atlas than on the board for the test fixture.

## Close conditions

- The read-only fly-through is usable and verified before any follow-on slice
  begins.
- Every visual property in the scene maps to real snapshot data; nothing
  decorative animates.
- Atlas is reachable and exitable in one action, and never becomes the only path
  to a task or session.
- The scene stays legible and interactive at the fixture scale, with a documented
  plan for larger.
- Reduced-motion and the board-as-accessible-path guarantees hold.
- Settings, navigation, docs, and tests are updated together.

## Description


## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Dependencies



## Comments


