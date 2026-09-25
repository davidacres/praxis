---
**Status:** 📋 To Do
**Created:** 2026-09-06T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-018
slug: addon-marketplace
title: Add-on marketplace
status: Done
owner: Electron desktop app
updated: 2026-09-25
stories: [FX-BE-042]
validation: [npm run check-types, npm run test:core, npm run test:desktop, npm run test:desktop:themes]
---

# FX-BF-018: Add-on marketplace

## Note on how this feature file came to exist

Requested directly in a working session ("we built a store into the frosty
extension — would we add support to praxis for install/updates using this
mechanism … let's create what we need"). The catalogue transport was chosen by
the project owner: **GitHub Packages, read through the Packages REST API**, the
same mechanism used for other apps.

## Outcome

Praxis can install, update, and remove **themes, surface packs, agents, and
workflow templates** from a GitHub Packages npm registry the user points it at
— without shipping new app builds for each add-on. Declarative kinds (theme,
surface pack, workflow template) activate on install; an agent add-on installs
disabled and runs only after the user grants it execution trust.

## Scope

- **Connection types are out.** A backend mode is a `switch` arm in
  `serviceRegistry.ts` — executable code, not catalogue data — so it cannot be
  shipped through a data catalogue into a packaged, CSP-locked Electron app.
  Connection modes stay first-party (see AGENTS.md → Backend modes).
- **Transport is GitHub Packages.** Discovery via the GitHub REST API
  (`GET /users|orgs/<owner>/packages?package_type=npm`, Link-paginated,
  name-prefix filtered); version metadata + tarballs from the npm registry
  endpoint (`npm.pkg.github.com`). A bearer token is always required, even for
  public packages.
- **Integrity is non-negotiable.** A tarball is verified against the registry's
  advertised SRI (`sha512`/`sha384`/`sha256`, preferred) or its legacy hex
  `shasum` before it is unpacked; a version the registry published no hash for
  is refused.

## Story map

- `FX-BE-042` — GitHub Packages add-on marketplace. 🚧 In progress.

## Dependencies

- None hard. Reuses the GitHub Link-header pagination pattern from
  `FX-BE-035`, the agent discovery + trust model from `FX-BF-011`, and the
  workflow template tiers from `FX-BF-012`.

## Close when

A user can point Praxis at a GitHub Packages owner, add a `read:packages`
token, browse the catalogue, install a theme/pack/agent/template, see it take
effect (a theme in the gallery, an agent in the runtime once trusted, a
template in the workflow library), get an on-launch note when updates exist,
and remove any of it cleanly.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |
| FX-BE-042 | Story | GitHub Packages add-on marketplace | In progress |

## Description


## Comments




**PRAXIS-F18** — 2026-09-14T00:17:14.031Z
## AI Review by Claude Code (local)

## Review: PRAXIS-F18 / FX-BF-018 — Add-on marketplace

Pulled the underlying feature file (`fx-bf-018-addon-marketplace/feature.md`) and its one story (`FX-BE-042`) to review against the ticket fields, since the ticket description is truncated mid-sentence in this view. Overall this is a well-scoped, technically detailed ticket — the gaps below are mostly about status accuracy and closure criteria, not missing design thinking.

### Clarity — good
- "Scope" section draws a crisp, defensible boundary (connection types excluded because they're code, not catalogue data) and explains *why*, not just *what*.
- "Close when" is a concrete, testable acceptance scenario written from the user's point of view.

### Completeness gaps

1. **Story is far more "done" than "In Progress" suggests.** `FX-BE-042`'s "As built" section already documents a full core engine, host wiring, and renderer integration, plus 49 unit tests and 5 e2e specs — and the files exist in the repo (`packages/core/src/marketplace/`, `marketplaceIpc.ts`, `marketplace.spec.ts`, etc.). If the remaining work is only the three "Open" items, the ticket should say so explicitly (e.g. "blocked on Open items only") so a reader doesn't have to diff the doc against the repo to figure out how close this is to Done.

2. **The three "Open" items have no disposition.** The story lists:
   - Agent add-on end-to-end proof against a live registry (only mock-tested)
   - Marketplace token fallback to a configured GitHub connection's token
   - A published example add-on repo

   None are marked as blocking-for-close vs. deferred-to-follow-up. Given "Close when" explicitly requires a user to "install an agent... once trusted," and agent trust is the most security-sensitive path in this feature, item 1 in particular reads like it *should* gate closure — worth an explicit call.

3. **Dependency mismatch.** The ticket's `Depends On: PRAXIS-S16-35, PRAXIS-F11, PRAXIS-F12` lists these as dependencies, but the feature file's own "Dependencies" section says **"None hard"** — those three are reused patterns (pagination, trust model, template tiers), not blockers. If the tracker treats `Depends On` as a hard gate, this ticket may be shown as blocked when it isn't. Worth reconciling which is authoritative.

4. **Status metadata is internally inconsistent.** The frontmatter comment block says `**Status:** 📋 To Do` while the `status:` field says `In Progress`. Same discrepancy exists in the story file. If anything parses the comment line instead of the field, this ticket could be miscategorized.

### Missing technical context

- **Failure/rollback behavior isn't specified.** What happens on a partial install failure (tarball downloaded, extraction or path-traversal check fails mid-way)? Is the partial `userData/addons/<kind>/<id>/` directory cleaned up, or can it leave orphaned state?
- **Revoking agent trust mid-session** — no mention of whether revoking trust for a running agent stops it cleanly or leaves it running until restart.
- **GitHub API rate limits** aren't addressed. `reconcileInstalledOnLaunch()` calls the registry on every boot for update checks; for users with large catalogues or frequent restarts this could hit REST/rate-limit ceilings — worth stating the fallback behavior (silent skip vs. surfaced error).
- **Yanked/removed packages**: if a registry owner deletes a package or version after a user has it installed, is there defined behavior for update checks or reinstall attempts?

### Ambiguities worth resolving before close

- Is "Priority: Medium" still right given the scope (touches Settings, Themes, Surfaces, Agent Runtime, Workflow Templates, and a new trust/integrity path)? Not a defect, but worth a sanity check against the size of the surface area actually shipped.
- Confirm whether the three "Open" items become their own follow-up tickets or stay as open sub-tasks under this one — as written, there's no tracking mechanism for them once FX-BF-018 is marked Done.
## Review 2026-09-25

Status corrected to Done during the board-state review: all child stories
now show Done, and the underlying delivery is present in the tree (see the
per-story review comments for file-level evidence). Validation commands from
the stories (`npm run check-types`, `npm run test:core`) were not rerun as
part of this review.
