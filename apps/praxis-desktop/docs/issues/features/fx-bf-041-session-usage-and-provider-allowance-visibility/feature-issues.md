# FX-BF-041 — Session usage and provider allowance visibility

**Type:** Feature
**Status:** Complete
**Owner:** Electron desktop app

## Outcome

Praxis Desktop makes session consumption, recent usage windows, spend warnings,
and optional provider account allowance data visible without exposing provider
secrets to the renderer.

## Stories

- [FX-BE-129 — Session usage, cost, and provider allowance visibility](stories/fx-be-129-session-usage-cost-and-provider-allowance-visibility/issue.md)

## Close condition

The session panel reports local usage and threshold pressure, OpenAI usage can
be connected through a securely stored Admin key, and other providers can add
usage adapters without changing the UI contract.
