# Bifrost AI Gateway integration

Research checked against the official documentation on 2026-10-02.

## Setup in Praxis

Settings → AI Provider → Add provider → Bifrost AI Gateway.
The preset creates a named OpenAI-compatible endpoint with server root
`http://localhost:8080`, API path `/openai`, and secret-header authentication
`x-bf-vk`. Change the root for your deployment; use HTTPS for a remote gateway.
Paste a Bifrost virtual key in the API key field. Praxis stores it in the
existing encrypted secret store, separately from settings.

Run the connection test to discover models and verify chat, streaming, usage
and tool calling. You can enter a model manually if discovery is unavailable.
Provider-prefixed IDs such as `openai/gpt-4o-mini`, and gateway aliases, are
preserved on the wire. The endpoint is available to the existing session,
recommendation and workflow provider pickers; agent sessions require a model
that supports tools. You can add separate endpoints/virtual keys for different
teams or budgets.

The [OpenAI integration](https://docs.getbifrost.ai/integrations/openai-sdk/overview)
documents `/openai`, model prefixes and virtual keys. The
[governance overview](https://docs.getbifrost.ai/features/governance/budget-and-limits)
documents `x-bf-vk`. The preset sends the virtual key through this one field,
avoiding the dual-credential behavior of supplying both bearer and virtual-key
headers. Users can edit authentication for their deployment.

## Feature fit

| Feature | Praxis integration and boundary |
| --- | --- |
| Streaming and tools | Uses the existing agent loop and capability probe. Tool execution and approval remain with Praxis. |
| Reasoning | Bifrost adapter sends `reasoning.effort` for low/medium/high; off leaves the gateway default. Bifrost converts effort for the upstream provider. Streamed `delta.reasoning` is recognized as thought output. Model support still varies. |
| Routing, fallback and load balancing | Configure in Bifrost; Praxis sends the chosen model/alias. No duplicate gateway routing engine in the desktop app. |
| Virtual-key budgets | Configure monetary limits and request/token throttles in Bifrost. Existing Praxis provider-limit handling recognizes budget/rate-limit errors. |
| Pricing and costs | Recognized model IDs get existing local rate estimates in model pickers and completed-turn telemetry. Unknown aliases do not have authoritative pricing in Praxis. |
| Caching | Configure in Bifrost; the adapter never sends Vercel-only caching/thinking options. Gateway cache discounts are not reconciled into local estimates. |
| Observability | Bifrost request logs and telemetry are useful for debugging routing, latency and cost; this change adds no gateway log ingestion. |
| Gateway MCP | Potential separate MCP connection through Praxis's existing MCP system. This provider change does not enable remote autonomous tool execution. |

See [reasoning](https://docs.getbifrost.ai/providers/reasoning),
[routing](https://docs.getbifrost.ai/providers/provider-routing), and
[request options](https://docs.getbifrost.ai/providers/request-options).

## Budgets and model pricing

Bifrost checks applicable provider-configuration, virtual-key, team and customer
budgets independently. A failed check blocks the request; provider-level limits
can remove a provider from routing. Request and token limits apply at virtual-key
and provider-configuration levels. Budget checks happen before inference and usage
is charged afterward, so a request can overshoot the remaining budget before the
next request is refused. Do not describe these as an exact preauthorized spend cap.
See [budget and limits](https://docs.getbifrost.ai/features/governance/budget-and-limits).

Bifrost maintains a pricing catalog, with a default 24-hour sync, and supports
scoped overrides. Rates can differ by provider, key and virtual key, and include
cache, batch and service-tier rates. Its cost accounting should therefore be the
source for gateway spend; Praxis's input/output-token estimates cannot reproduce
those adjustments or know which fallback model served a request. There is no
single universal Bifrost model price to hard-code.
See [custom pricing](https://docs.getbifrost.ai/providers/custom-pricing).

## Follow-up opportunities

1. Read-only allowance adapter: expose authorized virtual-key usage, limit and
   reset timestamps through the existing `ProviderUsageSnapshot` contract.
   Confirm deployment authentication and scope before accessing governance APIs;
   inference access must not imply access to other consumers' budgets.
2. Gateway pricing adapter: fetch effective prices for the selected virtual key
   and model, convert per-token USD to Praxis's per-million-token fields, and
   retain source/freshness. Alias resolution and scoped override precedence are
   required before replacing local estimates.
3. Request-cost reconciliation: correlate Praxis sessions/turns with Bifrost
   request IDs and resolved provider/model; import recorded costs without counting
   both estimates and actual charges. Keep provenance visible.
4. Session affinity: investigate gateway affinity headers to retain prompt-cache
   locality through multi-turn sessions, while keeping the gateway's routing
   policy authoritative.

These management/read-side APIs are not implemented in this change. The existing
account-usage UI reports them as unavailable for the Bifrost endpoint.

## Verification boundary

The automated Bifrost test uses a local OpenAI-compatible fixture: it proves
catalog setup, `/openai` paths, secret storage, virtual-key headers, capability
probing, provider selection, reasoning payloads, streamed usage and turn-cost
estimates through the production Electron runtime. A deployed Bifrost instance
with upstream credentials is still needed to verify real routing, governance
enforcement and provider-specific reasoning conversion.
