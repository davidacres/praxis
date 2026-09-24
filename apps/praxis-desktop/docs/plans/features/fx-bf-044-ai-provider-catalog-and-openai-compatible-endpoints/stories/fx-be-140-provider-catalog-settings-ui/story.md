---
**Status:** ✅ Complete
**Created:** 2026-09-24T00:00:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-140
title: "Provider catalog settings UI"
status: Complete
feature: FX-BF-044
updated: 2026-09-24
dependencies: [FX-BE-137, FX-BE-138, FX-BE-139]
validation: [npm run check-types, npm run build, npm run desktop:copy-renderer, npx playwright test aiProvider.spec.ts aiProviderTabs.spec.ts]
---

# FX-BE-140: Provider catalog settings UI

## User or operational impact

Settings → AI Provider → Providers shows the providers in use and an
**Add provider** button that opens a searchable catalog. Screen designs
(four screens, Praxis Light): https://claude.ai/artifact/3cZh9Nab79EkHcCsgNpX7r

## Scope

- **Providers tab (list).** Same `ai-provider-row` component and behaviour
  (chevron, Default chip, Make default, switch). Row shown when configured ∨
  default ∨ `added`. Each row gains a small kind tag (`API`, `Local`, `CLI`,
  `Custom`) and, for custom instances, capability chips from the last probe.
  Header right: **Add provider** (`btn btn-primary btn-compact`). Empty
  state when nothing is added (fresh install): one sentence + the button.
- **Add provider dialog** (existing dialog primitives, same as the
  command-palette/connection dialogs): search field; sections *Built-in*,
  *Cloud (OpenAI-compatible)*, *Local runtimes*, *CLI agents*, *Custom*.
  Each tile: icon, name, one-line note, and state (`Added`, `Detected on
  PATH`, `Key required`, `No key`). Picking a built-in sets `added: true`
  and expands its row; picking a preset or Custom opens the endpoint form
  pre-filled.
- **Endpoint form** (custom instances; `FieldRow` / `DebouncedTextField` /
  `ChipSelect` only — no new primitives): Name, Base URL, API path
  (advanced), Authentication (`Bearer key` · `No key` · `Custom header`),
  API key (keychain, same Save/Test/Clear trio as built-ins), Extra headers
  (advanced, key/value rows), Default model (picker fed by `/models`, or
  free text + "Add model id" when there is no list), **Test connection**
  with the four-step result list, then Save. Plain-HTTP + key to a
  non-loopback host shows the warning banner.
- **Remove** on custom rows (and "Remove from list" on unconfigured added
  built-ins) with confirm; the default provider cannot be removed (same
  lock as its switch).
- Renderer labels/icons for provider ids come from `AiProviderStatus`
  (`modelProviders.ts` keeps its literals only as a fallback for built-ins).
- No new CSS tokens; custom instances use `--tone-openai`-neutral styling via
  the existing `globe`/`terminal` fallback icon rule.
- Update `apps/praxis-desktop/renderer/AGENTS.md` "AI provider settings":
  replace "add a provider by adding to `AI_PROVIDERS`" with the catalog rule.

## Acceptance criteria

- Existing user with Vercel configured sees exactly one row, as today.
- e2e: add Custom → point at `mockGatewayServer` → Test shows 4/4 → Save →
  row appears, Make default works, composer model picker lists the mock's
  models.
- e2e: remove a custom instance; its keychain entry is gone
  (`ai:getProviderStatus` reports unconfigured).
- Screenshots of list, dialog, form (light + one dark theme) inspected per
  "Verifying a UI change".

## Delivered

As scoped, plus: the New Session provider menu refreshes provider statuses when opened, so an
endpoint added in Settings is offered without a reload; Escape closes the catalog without also
closing Settings. `aiProviderTabs.spec.ts` was updated where it relied on unconfigured built-ins
being rows. e2e: `aiProviderCatalog.spec.ts` (4 tests, including geometric no-overlap checks
at a 1024px window).
