---
**Status:** ✅ Complete
**Created:** 2026-09-15
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-122
title: "Opt-in multi-AI conversation in one session"
status: Complete
feature: FX-BF-035
updated: 2026-09-15
dependencies: [FX-BE-115, FX-BE-092, FX-BF-015, FX-BF-017]
---

# FX-BE-122: Opt-in multi-AI conversation in one session

## Outcome

A user can invite a second AI into an existing Praxis session so the two models
talk to each other in the same chat, with each speaker visually distinct, while
ordinary **Hand over** stays a one-way relay. The conversation is advanced and
opt-in: it is never the default, it has a hard turn cap, and only one participant
holds tools at a time.

## Product decisions

- This is not a tweak to FX-BE-115 handover. **Hand over** remains A stops, B
  inherits purpose, brief and files. Multi-AI chat is a **conversation**: both
  remain in the transcript and take turns.
- One user-visible Praxis session, one worktree, one living brief. Participants
  are named speakers on message events, not successor sessions and not fake user
  turns.
- Entry point is a separate composer action such as **Bring in another AI**,
  never a silent extra step inside Hand over. The dialog names spend (two models)
  and the turn cap before anything starts.
- Modes are explicit: **consult** (guest is read-only advice), **debate**
  (both argue, neither writes), **pair** (host keeps tools; guest is read-only
  unless the user promotes it). Praxis never lets two runtimes write the same
  worktree concurrently.
- The chat paints each AI as an assistant with a stable identity (provider label
  plus model), using tokens — not a second user bubble and not the accent as the
  only differentiator.
- The user can interrupt, stop the conversation, or promote/demote tool ownership
  between turns. A hard turn cap and the existing spend warning bound cost.
- Default handover, model change and single-agent follow-ups stay byte-identical
  when this mode is not started.

## Tasks

- **TASK-329 Add conversation, participant and speaker-attribution contracts.**
- **TASK-330 Host bounded turn-taking between two providers in one session.**
- **TASK-331 Render each AI as a distinct speaker in the session chat.**
- **TASK-332 Add Bring in another AI, stop and tool-owner controls.**
- **TASK-333 Enforce tool ownership, turn cap and spend visibility.**
- **TASK-334 Prove conversation, identity and safety end to end.**

## Acceptance

Ordinary Hand over still transfers once and does not start a back-and-forth.
Bring in another AI, after confirmation, shows both models in the same transcript
with distinct identities. Consult/debate never write; pair writes only through the
current tool owner. The conversation stops at the turn cap, on user stop, or on
failure, leaving the session usable as a single-agent chat. Keyboard focus, themes
and surface packs remain coherent.

## Evidence

Core contract and host tests with stub providers; desktop e2e for identity in the
chat, disabled states and stop/cap behaviour; opt-in live proof that two real CLIs
exchange visible turns without concurrent writes. No live spend in the default
suite.

## Description


## Dependencies


## Comments
