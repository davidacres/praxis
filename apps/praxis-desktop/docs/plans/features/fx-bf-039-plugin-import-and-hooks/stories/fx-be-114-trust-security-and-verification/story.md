---
**Status:** 📋 Proposed
**Created:** 2026-09-14
**Type:** Story
**Priority:** Critical
type: Story
id: FX-BE-114
title: "Trust, security, and verification"
status: Proposed
feature: FX-BF-039
updated: 2026-09-14
dependencies: [FX-BE-110, FX-BE-113]
---

# FX-BE-114: Trust, security, and verification

## Outcome

Nothing an imported plugin brings — a hook script, an MCP server pointed at a new
URL, an agent profile with elevated tool requirements — executes or takes effect
before the user has explicitly trusted it, following the same trust-on-install
discipline FX-BF-018 already established for Praxis's own add-on marketplace, and
backed by the real diff view FX-BE-110 built rather than a bare re-confirm. The
whole feature has deterministic fixture coverage and is documented for both users
and future maintainers.

## Tasks

- **TASK-320 Extend the existing trust-on-install gate to imported plugins and hook scripts**, treating a hook — the one genuinely new execution surface this feature adds — as at least as sensitive as an installed agent, and requiring FX-BE-110's diff view (not a bare confirm) whenever an update changes executable content.
- **TASK-321 Add deterministic fixtures and e2e coverage** for the full import → convert → preview → install → bind → hook-build → hook-fire journey across all four provider categories, plus documentation covering both the import model and the hook engine.

## Acceptance

Installing a plugin never runs any of its code; only an explicit trust grant does.
Updating an already-trusted plugin whose hook scripts or MCP server URLs changed
shows the actual diff and re-prompts rather than silently carrying the old grant
forward. The feature's own fixtures reproduce real content from both upstream
marketplaces (inspected during scoping), not synthetic stand-ins, so a future
upstream format change is something the test suite would actually catch.

## Evidence

An e2e test proving a freshly installed, untrusted plugin's hook never fires; a
trust-revocation test proving revoking trust stops a previously-trusted plugin's
hooks and MCP servers; a diff-shown-not-bare-confirm test on update; and full-suite
`check-types`/`test:core`/`test:desktop` passes as this feature's own definition of
done requires.

## Description


## Dependencies



## Comments
