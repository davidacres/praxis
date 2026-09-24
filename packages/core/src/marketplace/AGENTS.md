# Agent notes: `packages/core/src/marketplace`

Area-specific guidance, moved out of the root [AGENTS.md](../../../../AGENTS.md).
The root file still holds the rules that apply to every change; read it too.

## Add-on marketplace (`packages/core/src/marketplace/`, FX-BF-018)

Installs **themes, surface packs, agents, and workflow templates** from a
**GitHub Packages** npm registry the user configures. Not connection modes —
those are code (see "Workspace / project / connection model" in the root AGENTS.md), never catalogue data.

- **Two endpoints, one transport.** Discovery is the GitHub REST API
  (`GET /users|orgs/<owner>/packages?package_type=npm`, Link-paginated,
  name-prefix filtered). Version metadata and tarballs come from
  `npm.pkg.github.com` (a standard packument). A bearer token is required for
  **both**, even for public packages — 401/403 carry a `read:packages` hint.
- **The core module has no host dependencies.** No `fs`, no Electron — disk
  work goes through the `AddonStorage` port (`ElectronAddonStorage` writes
  `userData/addons/<kind>/<id>/`). It unit-tests with a fake fetch + in-memory
  storage.
- **A tarball is verified before it is unpacked.** `assertTarballIntegrity`
  checks the registry's SRI (`sha512`/`384`/`256`) or hex `shasum`; a version
  the registry published **no** hash for is refused, not waved through.
- **Config is central; browsing is per-kind.** Settings → **Add-ons** holds
  only the marketplace *config* (owner, token, endpoints, enable). Each kind's
  own panel — Themes, Surfaces, Agent Runtime — carries its own marketplace
  section that browses and installs *that kind*, so a user installs a theme
  where they pick themes. `useKindAddons(kind)` (`settings/marketplaceAddons.ts`)
  wraps `window.praxis.marketplace.*` and filters catalogue/installed to one
  kind. Do **not** add a cross-kind catalogue back to the Add-ons panel.
- **Declarative kinds activate on install; an agent does not.** `theme`,
  `surface-pack`, `workflow-template` are config and take effect immediately.
  An `agent` add-on installs **disabled** — its payload is mirrored into
  `userData/agents/<id>` (the trusted discovery root) only once the user grants
  trust (in the Agent Runtime panel's marketplace section), and removed on
  revoke. Nothing downloaded runs code until then.
- **Manifest `display` hints make the catalogue visual.** A `theme`/`surface-pack`
  add-on's `praxis.display.preview` (+ `.mode` for themes) lets the panel render
  a real preview card *before* install — the payload isn't downloaded for the
  browse list.
- **Marketplace themes/packs are a separate bucket.** `registerMarketplaceThemes`
  / `registerMarketplaceSurfacePacks` (renderer `settings/themes.ts` +
  `surfacePacks.ts`) are distinct from `registerCustom*`, which the Themes /
  Surfaces editors call with the user's own drafts. Merging the two into one
  `registerCustom*` call means whichever runs last wins and silently drops the
  other set. `main.tsx` re-registers the marketplace buckets on every
  `marketplace:changed` and dispatches `praxis-marketplace-appearance` so an
  open panel re-reads the lists.
- **Token lives in the secret store**, key `marketplace:githubToken`, with a
  `PRAXIS_MARKETPLACE_TOKEN` env fallback — the e2e sandbox and headless CI
  have no `safeStorage` keychain (same as `github.spec.ts`).
- **`MarketplaceSettings` is mirrored** in `renderer/settingsDefaults.ts` like
  every other settings section — add the field there too or Settings drifts.
- e2e: `mockAddonRegistry.ts` serves both endpoints from one in-process server
  and builds real gzipped tarballs so the integrity path runs for real;
  `marketplace.spec.ts` drives install/remove/trust from each panel.
- **Agents never choose their AI.** A session uses the session's AI; a workflow stage
  uses its own AI if the designer set one (`agent.providerId`), else the run's
  (`stageProvider`). There is no per-agent "Runs on" and no runtime-pin add-on: an
  add-on reusing a built-in agent's id is never mirrored over it, and Praxis's retired
  pin packages are removed on launch (`removeRetiredPinAddons`).
- **Budget limits.** A stage whose AI runs out pauses (`pause: 'provider-limit'`, the
  attempt records `provider`, and is free). The run's `providerLimitPolicy` then
  decides: `ask` (default) waits for the user — Switch AI / Retry / Stop on the run
  page; `switch` moves the stage to the next usable AI (`chooseFallbackProvider` →
  `fallbackProviderForStage`, skipping `exhaustedProviders`); `stop` ends the run
  (`provider-limit-stop`) with a reason naming the AI and stage. `stage-provider-switched`
  records `run.stageProviders` and re-queues the stage, reopening a stopped run. A stage's
  exact model only applies on its own AI, the run's model only on the run's.
  **`normalizeWorkflowRun` whitelists run fields** — add new ones there or they vanish
  on save. A normal session that runs out gets `SessionLimitSwitch` in its composer
  (handover to another usable AI, or stop).
- **Working style** (`ai.workingStyle`, `DEFAULT_WORKING_STYLE`, mirrored in
  `settingsDefaults.ts`) is added to every session's system prompt on every runtime
  via `launchAgentTask`/`continueAgentTask`; `nativeSources.instructionSource` limits
  the project instruction files Praxis adds to one tool's.
