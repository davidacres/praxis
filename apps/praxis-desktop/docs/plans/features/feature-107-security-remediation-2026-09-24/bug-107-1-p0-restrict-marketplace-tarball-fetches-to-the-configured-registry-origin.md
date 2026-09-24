# [P0] Restrict marketplace tarball fetches to the configured registry origin

**Status:** ✅ Complete
**Created:** 2026-09-24T15:41:51.172Z
**Type:** Bug
**Priority:** Highest
**Severity:** High
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P0 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-001** (High, CWE-522 / CWE-918) — `packages/core/src/marketplace/registryClient.ts:283-295` (`downloadTarball`), reached from `packages/core/src/marketplace/marketplaceService.ts:120` (catalogue browse) and `:173` (install); token source `apps/praxis-desktop/main/src/main/marketplaceInstance.ts:72-84`.
- **SEC-013** (Low, CWE-409) — `packages/core/src/marketplace/tarballManifest.ts:20`, called from `packages/core/src/marketplace/marketplaceService.ts:121`.

## Why this priority

The only user action required is opening the add-on catalogue. `downloadTarball` attaches the real GitHub PAT (from the OS secret store under `marketplace:githubToken`, or `PRAXIS_MARKETPLACE_TOKEN`) as a Bearer header to whatever absolute URL `dist.tarball` names, with no origin check — so a hostile or typosquatted package in the browsed namespace receives the token on the first request, before any redirect rule could strip it, with no install and no trust prompt. Grouped with SEC-013 because both are the same untrusted input on the same path: `resolveCatalogEntry` downloads *and gunzips* those bytes before `assertTarballIntegrity` has ever run (that check only exists on the install path at `:174`), and `listCatalog` resolves every package concurrently via `Promise.all`. One S-sized change to the same two files closes both.

## Change

- `packages/core/src/marketplace/registryClient.ts` — add a private origin assertion that parses the URL and requires `origin === new URL(this.registryBaseUrl).origin`; call it at the top of `downloadTarball` before the `Authorization` header is built, and throw (with the rejected origin logged) rather than falling back to an unauthenticated fetch — a tarball from an unexpected origin is not the artefact the packument's integrity hash describes. Apply the same check against `apiBaseUrl`'s origin to the paginated `Link` header URL in `listAddonPackages`. In the constructor, require `https:` for both configured base URLs.
- `packages/core/src/marketplace/marketplaceService.ts:118-128` — call `assertTarballIntegrity(tarball, versionEntry.dist)` before `readPraxisManifestFromTarball`, matching what the install path already does at `:173-174`.
- `packages/core/src/marketplace/tarballManifest.ts:20` — pass `{ maxOutputLength: <a few MB> }` to `gunzipSync` and treat `ERR_BUFFER_TOO_LARGE` as an invalid package; bound the input length before decompressing; prefer the async `gunzip` so a large archive cannot block the main process event loop.

## Verification

Extend `packages/core/src/marketplace/registryClient.test.ts` (already uses a fake fetch): a packument whose `dist.tarball` points at a different origin must produce **no** request carrying an `Authorization` header, and `downloadTarball` must reject. Extend `marketplaceService.test.ts` so a catalogue entry whose tarball fails the integrity hash is dropped without being parsed. Extend `tarballManifest.test.ts` with a small gzip that expands past the cap and assert an invalid-package error rather than an OOM. Run `npm run test:core`.

## Effort

S

## Depends on

None.

## Risk

If any genuinely published add-on is served from a host other than `registryBaseUrl` (a CDN target written into `dist.tarball`), installs and catalogue entries break — check a real GitHub Packages packument before shipping, and log the rejected origin so the failure is diagnosable rather than silent. Moving the integrity assertion earlier means entries with a missing or wrong hash vanish from the catalogue instead of appearing without a manifest; decide whether that should be silent or surfaced to the user.

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

- 2026-09-24: Done. Token only sent to the configured registry/API origins (https, loopback excepted); catalogue checks tarball integrity before parsing; manifest reader caps inflation at 64 MB. Tests in packages/core/src/marketplace.

