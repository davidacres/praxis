# FX-BE-039 — Cost and token spend report

**Type:** Story  **Status:** Complete  **Priority:** P2  **Depends on:** FX-BF-015

## Business or operational impact
Per-session cost/tokens existed, but the only place a total ever appeared was the composer's spend-limit banner, and only once within a third of the limit. There was nowhere to just look: "what has this cost so far" had no answer short of reading every session by hand.

## Scope
- Three new pure functions in `sessionNav.ts` — `summariseSpendByProviderModel`, `summariseSpendByConnection`, `sessionsWithinDays` — all built on the existing `summariseSpend` rather than reimplementing its currency-safety rules.
- A report block in Settings → AI Provider, under the existing spend-limit field: total cost by currency, a provider/model breakdown, a connection breakdown, and an All time / 30 days / 7 days filter.
- Self-contained like the section's existing `listProviderStatuses` call — fetches `listSessions` and stays live via `onSessionChanged`/`onSessionDeleted` rather than growing App's prop surface.

## Acceptance criteria
- A group's row shows cost per currency it actually reported and tokens if any session in it reported those — never one blended figure, never a token count turned into an invented cost.
- The report updates live as sessions complete, without reopening Settings.
- A time range with no sessions shows an explicit empty state, not a blank report.

## Validation
- `npm run check-types`
- `npm run test:desktop` (`aiSpendReport.spec.ts`)

## Close when
A user can see what their AI usage has cost — and which provider/model/connection is driving it — without reading every session individually.
