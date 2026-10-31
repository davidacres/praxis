---
**Status:** 📋 Proposed
**Created:** 2026-10-31T02:46:10.662Z
**Type:** Story
**Priority:** Medium
id: FX-BE-191
type: Story
status: To Do
---

# FX-BE-191: Send notes and linked groups to sessions

## Goal

Explicitly review and send immutable snapshots using the current session flow.

## Acceptance criteria

- Offer Send to session for one note or an ordered group. Select an existing or new compatible session in the same project and preview snapshot titles/body/order. Let the user add instructions. Require explicit Send; cancel, opening and destination creation produce no provider request. Extend existing context types and compact chat receipts as needed.
- Record snapshot provenance and content in the session message without live coupling. Test later edits, deleted notes, empty groups, unavailable destinations, provider rejection, rapid double-clicks and retry. Preserve notes and unsent instructions after failure. Reuse current submission safeguards and avoid hidden AI calls on ordinary note actions.

## Dependencies

FX-BE-190

## Description


## Comments
