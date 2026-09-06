---
**Status:** 📋 Proposed
**Created:** 2026-09-06T05:44:06.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-042
title: GitHub Packages add-on marketplace
status: in-progress
feature: FX-BF-018
updated: 2026-09-06
commits: []
dependencies: []
validation: [npm run check-types, npm run test:core, npm run test:desktop, npm run test:desktop:themes]
---

# GitHub Packages add-on marketplace

## User or operational impact

Themes, surface packs, agents, and workflow templates all ship baked into the
app today. Adding one means a release. This story makes them installable from a
GitHub Packages npm registry the user configures, with independent versions and
update checks.

## As built (2026-09-06)

### Core engine — `packages/core/src/marketplace/` (no host deps)

- `registryClient.ts` — `MarketplaceRegistryClient` interface +
  `GitHubPackagesRegistryClient`. `listAddonPackages()` calls the GitHub REST
  API (`/users|orgs/<owner>/packages?package_type=npm`), Link-paginated,
  filtered by name prefix (default `praxis-addon-`). `getPackument()` /
  `downloadTarball()` hit `npm.pkg.github.com`. Bearer auth throughout; 401/403
  carry a `read:packages` hint.
- `catalogTypes.ts` — `AddonKind` = `theme | surface-pack | agent |
  workflow-template`. `AddonManifest` is the `praxis` block in a package's
  `package.json` (read from the packument, no tarball download needed for the
  browse list). `CatalogEntry`, `InstalledAddon`, `AddonUpdate`,
  `AddonThemeContent`, `AddonSurfacePackContent`.
- `addonManifest.ts` — `validateAddonManifest`, errors vs warnings, mirrors
  `validateAgentManifest`.
- `integrity.ts` — `assertTarballIntegrity`: SRI (`sha512`/`sha384`/`sha256`)
  preferred, hex SHA-1 `shasum` fallback, constant-time compare, hard refusal
  when the registry advertised no hash.
- `semver.ts` — a small comparator (no `semver` dep) for version ordering and
  `minAppVersion` gating.
- `marketplaceService.ts` — `listCatalog` / `install` / `checkForUpdates` /
  `update` / `remove` / `setAgentTrust` over an injected `AddonStorage` port.
  Declarative kinds install enabled; an agent installs disabled unless
  `trustAgent` is passed.

### Host wiring — `apps/praxis-desktop/main`

- `adapters/electronAddonStorage.ts` — `AddonStorage` over
  `userData/addons/<kind>/<id>/`. Unpacks `package/addon/**` from the npm
  tarball via `tar` (dynamic import; it is ESM and the process is CJS),
  `strip: 2`, filtered, with a post-extract path-traversal check.
- `marketplaceInstance.ts` — builds `MarketplaceService` from
  `settings.marketplace` + the secret token; `buildMarketplaceService` throws a
  user-facing reason when unconfigured. Activation:
  - **theme / surface-pack** — `readActiveAppearance()` shapes enabled add-ons
    for the renderer to register.
  - **agent** — mirrored into `userData/agents/<id>` **only while trusted**, so
    the existing discovery + trust model runs it; the download stays under
    `userData/addons/agent/<id>`.
  - **workflow-template** — `marketplaceWorkflowTemplates()` folds enabled
    add-ons into the "global" tier across all four `workflowIpc.ts`
    library call-sites (`globalTemplateDefinitions()`).
  - `reconcileInstalledOnLaunch()` syncs agents and logs available updates on
    boot.
  - Token: secret store key `marketplace:githubToken`, with a
    `PRAXIS_MARKETPLACE_TOKEN` env fallback for the e2e sandbox / headless CI
    (no `safeStorage` keychain — same constraint as `github.spec.ts`).
- `marketplaceIpc.ts` — `marketplace:*` handlers; `marketplace:changed` pushed
  to every window after any mutation.
- Settings: `MarketplaceSettings` in core `appSettings.ts` (enabled, owner,
  ownerType, packageNamePrefix, apiBaseUrl, registryBaseUrl, checkOnLaunch) and
  its hand-maintained mirror in `renderer/src/settings/settingsDefaults.ts`.
- `MarketplaceIpc` on `PraxisIpc`; `window.praxis.marketplace` in the preload.

### Renderer

Config is central; browsing is per-kind.

- `SettingsPage.tsx` → **Add-ons** category = marketplace *config only* (owner /
  type, token, advanced endpoints, enable) plus a status line and installed
  count. No catalogue or install controls.
- `settings/marketplaceAddons.ts` — `useKindAddons(kind)` hook: wraps
  `window.praxis.marketplace.*`, filters catalogue + installed to one kind,
  exposes `browse / install / update / remove / setTrust / checkForUpdates`
  with `busy` / `error`, subscribes to `marketplace:changed`.
- `ThemesGallerySection` — the existing "Marketplace" section also renders real
  catalogue themes as `ThemePreviewCard`s built from `manifest.display.preview`
  / `.mode`; installed ones move to the gallery, with a "Installed from the
  catalogue: … Remove" line.
- `SurfacesSection` — a "Marketplace" block of compact cards (a colour strip
  from `display.preview` + Install); installed packs get a Remove on the
  gallery card.
- `AgentRuntimeSection` — a "Marketplace" block: installed agents with
  Trust / Revoke / Remove, catalogue agents with "Install (untrusted)".
- `themes.ts` / `surfacePacks.ts` — installed marketplace themes/packs get
  their own bucket (`registerMarketplaceThemes` /
  `registerMarketplaceSurfacePacks`), separate from the user's own custom
  entries, so the editors' `registerCustom*` calls and the marketplace's never
  clobber each other. `SurfacePackDefinition.source` gains `'marketplace'`.
- `main.tsx` — `applyMarketplaceAppearance()` on boot and on every
  `marketplace:changed`, then dispatches `praxis-marketplace-appearance` so an
  open panel re-reads the registered lists.
- `AddonManifest.display?` (`{ preview?, mode? }`) — optional catalogue-card
  hints so an uninstalled theme/pack shows a real preview.

### Add-on package shape

An add-on is an npm package whose `package.json` carries a `praxis` block
(`{ schemaVersion: 1, kind, id, name, summary?, contentVersion?,
minAppVersion?, author?, homepage?, display? }`, where `display` is
`{ preview?: colour map, mode?: 'light' | 'dark' }` for the catalogue card) and
whose tarball places a kind-specific payload under `package/addon/`:

| Kind | Payload file |
| --- | --- |
| `theme` | `theme.json` (id, name, mode, description, preview map, optional terminal palette) |
| `surface-pack` | `pack.json` (id, name, description, basePackId?, `--surface-*` tokens, optional pattern) |
| `agent` | `agent.json` + any skill files — the whole agent directory |
| `workflow-template` | `template.json` — a `WorkflowDefinition` |

## Tests

- `packages/core/src/marketplace/*.test.ts` — 49 unit tests (semver, integrity,
  manifest validation incl. `display`, registry client with a fake fetch,
  service with a fake client + in-memory storage:
  install/verify/pin/tamper-reject/minAppVersion/update/trust/remove).
- `apps/praxis-desktop/main/e2e/marketplace.spec.ts` + `mockAddonRegistry.ts` —
  one in-process server for both the REST listing and the npm
  packument/tarball, building real gzipped tarballs. Five tests: Add-ons panel
  is config-only; Themes panel installs a theme into the gallery and removes
  it; Surfaces panel installs/removes a pack; Agent Runtime installs an agent
  untrusted and gates it behind trust; an unconfigured marketplace explains
  itself in each panel.

## Open

- Agent add-on end-to-end proof against a live registry (only mock-tested).
- Marketplace token fallback to a configured GitHub connection's token.
- A published example add-on repo.

## Description


## Dependencies



## Comments


