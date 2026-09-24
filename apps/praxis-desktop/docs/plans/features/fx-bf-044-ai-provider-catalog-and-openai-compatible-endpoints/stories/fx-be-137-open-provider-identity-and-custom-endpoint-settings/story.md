---
**Status:** ✅ Complete
**Created:** 2026-09-24T00:00:00.000Z
**Type:** Story
**Priority:** Medium
type: Story
id: FX-BE-137
title: "Open provider identity and custom endpoint settings"
status: Complete
feature: FX-BF-044
updated: 2026-09-24
dependencies: []
validation: [npm run check-types, npm run test:core]
---

# FX-BE-137: Open provider identity and custom endpoint settings

## User or operational impact

None visible. Lands the types and settings shape so a provider instance can
exist without a code change, and proves existing settings load byte-identical.

## Scope

- `types.ts`: keep `AiProvider` (built-ins) and add
  `type CustomProviderId = \`custom:${string}\`` and
  `type AiProviderId = AiProvider | CustomProviderId`, plus
  `isCustomProviderId()`. Widen the fields that store a *chosen* provider
  (`activeProvider`, `recommendationProvider`, session/usage records,
  `modelTiers` keys, IPC args) to `AiProviderId`. `PROVIDER_DESCRIPTORS`,
  `ADAPTERS` and the pricing maps stay `Record<AiProvider, …>` — they describe
  built-ins only.
- `appSettings.ts`: add

  ```ts
  export interface CustomProviderConfig {
    id: CustomProviderId;            // 'custom:<slug>', stable once created
    label: string;                   // user-editable display name
    presetId?: string;               // catalog entry it was created from
    protocol: 'openai-chat';         // only value in v1
    baseUrl: string;                 // required, http(s) only
    apiPath?: string;                // explicit; skips endpoint() guessing
    auth: { kind: 'bearer' } | { kind: 'none' } | { kind: 'header'; name: string };
    headers?: Record<string, string>; // non-secret only
    manualModels?: string[];         // when the server has no /models
    streamUsage?: boolean;           // send stream_options.include_usage (default true)
    capabilities?: ProviderCapabilities; // last probe result (FX-BE-139)
  }
  ```

  `AiSettings.customProviders: CustomProviderConfig[]` (default `[]`).
  Per-instance `enabled` / `defaultModel` / `enabledModelIds` reuse
  `ai.providers[id]` (`AiProviderConfig`) exactly as built-ins do, so pickers
  and `isProviderUsable` need no second rule.
- Add `AiProviderConfig.added?: boolean` (the explicit "added from catalog"
  flag used by FX-BE-140's row visibility).
- `sanitizeAppSettings`: validate each instance strictly — id matches
  `^custom:[a-z0-9][a-z0-9-]{0,47}$`, URL parses with `http:`/`https:`,
  header names are RFC 7230 tokens and do **not** match
  `/token|secret|password|apikey|api_key|\bpat\b/i`, duplicates dropped.
  An invalid instance is dropped, never fatal. `readAiProvider` /
  `readOptionalAiProvider` accept a `custom:` id only if it exists in the
  sanitized `customProviders`, else fall back as today.
- `mergeAppSettings`: `customProviders` is replaced wholesale when present in
  a patch (it is a list, not a map); `providers` keys iterate
  `KNOWN_AI_PROVIDERS ∪ customProviders[].id` instead of the fixed list.
- `providerSecrets.ts`: `secretKeyForProvider('custom:x')` →
  `praxis.customProvider.x.apiKey`; `resetProviderApiKeys` includes instances;
  deleting an instance deletes its key.
- `resolveProviderDescriptor(id, settings)` in `registry.ts` returns a
  `ProviderDescriptor` for either tier; `providerDisplayName` takes settings
  for custom labels.
- Mirror the new defaults in `renderer/src/settings/settingsDefaults.ts`.

## Acceptance criteria

- A settings file with no `customProviders` round-trips through
  sanitize → merge → serialize byte-identical (unit test with a real current
  settings fixture).
- `activeProvider: 'custom:gone'` with no matching instance sanitizes to the
  default provider.
- A header named `Authorization-Token` is rejected; `HTTP-Referer` is kept.
- `npm run check-types` passes in all workspaces with no `as AiProvider`
  casts added to silence widening.

## Delivered

As scoped, with these differences: `AiProvider` was widened in place (built-ins are now
`BuiltInAiProvider`) rather than introducing a separate `AiProviderId`, so the compiler listed
every site that indexed `PROVIDER_DESCRIPTORS` — each now calls `getProviderDescriptor` /
`findProviderDescriptor`. `customProviders` is optional and omitted when empty, so an existing
settings file round-trips unchanged. Core reads the live list through
`setCustomProviderSource` (main points it at the settings backend), so an endpoint resolves the
moment its settings write returns. Removing an endpoint in `mergeAppSettings` also clears
`activeProvider`, `recommendationProvider`, `modelTiers` and `providers` entries that named it.
Tests: `appSettings.test.ts`, `customProviders.test.ts`.
