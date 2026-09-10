---
**Status:** 📋 Proposed
**Created:** 2026-09-06T00:00:00.000Z
**Type:** Feature
**Priority:** Medium
id: FX-BF-018
slug: addon-marketplace
title: Add-on marketplace
status: in-progress
owner: Electron desktop app
updated: 2026-09-06
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


