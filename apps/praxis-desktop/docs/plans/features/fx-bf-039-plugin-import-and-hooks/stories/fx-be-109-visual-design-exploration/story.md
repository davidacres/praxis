---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Story
**Priority:** High
type: Story
id: FX-BE-109
title: "Visual design exploration"
status: Proposed
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-108]
---

# FX-BE-109: Visual design exploration

## Outcome

Before any UI is built, this feature's two visual surfaces — browsing/trusting
imported content, and authoring/managing hooks — have a real design direction: mocked
screens, not a description in a task list. Both later UI stories (FX-BE-110,
FX-BE-112) implement against this output rather than inventing layout as they go.
This exists specifically because a first pass at scoping this feature treated the UI
as "make it match the existing settings list," which would ship something no better
than Claude Code's own `/plugin` menu — the opposite of the goal.

## Tasks

- **TASK-310 Design the plugin/agent/skill marketplace browsing experience**: a card grid in the spirit of the existing theme marketplace (live/rich previews, not name+description+button), an expandable preview showing an agent's actual instructions or a skill's actual body before install, and a diff view for what changed when an update needs re-trust.
- **TASK-311 Design the visual hook builder and hook management surfaces**: an event picker, a matcher builder, and an action picker that together replace hand-writing the native hook format, plus a management view listing every active hook (native and imported/passthrough) with recent firing history.

## Acceptance

Both designs are produced as artboards (or an equivalent reviewable mock), not
prose — reviewed against Praxis's existing visual language (the theme marketplace's
card pattern, the Agent Hub's existing catalog rows, the app's light/dark/surface-pack
theming) so neither surface reads as bolted-on. The hook builder design is validated
against at least one real imported hook (`hookify`'s, inspected during scoping) to
confirm the event/matcher/action shape it exposes can actually represent something a
real plugin does, not just a toy example.

## Evidence

Published design artifacts (or committed mock screens) covering: the marketplace
card grid in its empty, populated, and preview-expanded states; the install/update
trust-diff dialog; the hook builder's event/matcher/action steps; and the hook
management list with a firing-history entry expanded.

## Description


## Dependencies



## Comments
