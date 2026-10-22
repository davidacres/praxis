# Model reasoning response shapes — why the chat pane renders differently per model

Research for unifying how Praxis displays thinking / thoughts / reasoning across AI models.

> **Status:** §1–§7 are the research findings, written against the code *before* any fix; they
> describe what was wrong and why. Most of them have since been implemented — see **§8**, which
> records the implementation status per recommendation, a finding discovered only during the build,
> and the test evidence. Read §8 before acting on a finding in §1–§7.

Method: read every reasoning ingestion path in `packages/core` and every rendering path in
`apps/praxis-desktop/renderer`, then checked each provider's published API documentation for the
request and response shape. **No live provider calls were made** (no keys in this session), so
response-shape rows are from vendor docs and Praxis's own parsers, not from captured traffic.
Confidence is marked per finding.

Models specifically asked about: `qwen3.8`, `gpt-6-luna`, Claude Code, `minimax-m3`, `glm-5.3`.

---

## 1. The headline answer

Yes — models return reasoning in genuinely different shapes, and Praxis already collapses most of
that into one field (`AgentEventSummary.reasoning`). **The display inconsistency is not mainly
caused by the models.** It is caused by three separable things:

1. **Four different rendering widgets** for the same `reasoning` string (settled chat, streaming
   chat, AI review, agent timeline) plus a fifth surface that shows none (Assistant panel).
2. **Some models never return reasoning text at all**, so the same widget is empty for them —
   `gpt-6-*` and `gpt-5.*` over the HTTP API are the important case.
3. **Some models get the wrong request parameter**, so reasoning is never switched on and the
   widget is empty for a different reason — GLM, Qwen, MiniMax, and gateway-routed `claude-fable`.

Fixing (1) is a renderer job. Fixing (2) is a *design* job: a common display must have a defined
empty state, because "no reasoning available" is normal, not an error. Fixing (3) is a wire job and
is the one that silently degrades quality.

---

## 2. How reasoning enters Praxis today

There are **five** ingestion paths, each with its own extraction rule.

| Path | File | Reasoning source | Confidence |
| --- | --- | --- | --- |
| Anthropic Messages (direct) | `packages/core/src/ai/providers/anthropicWire.ts:226` | `delta.type === 'thinking_delta'` → `delta.thinking` | verified in code |
| Gemini (direct) | `packages/core/src/ai/providers/geminiWire.ts:287` | `part.thought === true` → `part.text` | verified in code |
| OpenAI-compatible (shared) | `packages/core/src/ai/gateway/wire.ts:579` | `delta.reasoning_content ?? delta.reasoning ?? delta.thought` | verified in code |
| Anthropic SSE **fallback** inside the gateway | `packages/core/src/ai/gateway/wire.ts:476-538` | **none — `thinking_delta` is not handled** | verified in code |
| ACP CLI agents | `packages/core/src/ai/acp/acpAgentHost.ts:741` | `sessionUpdate === 'agent_thought_chunk'` → `content.text` | verified in code |

The OpenAI-compatible path is the one that matters most: it serves `vercel-gateway`, `openai`,
`z-ai`, and **every** custom preset — MiniMax, Alibaba (Qwen), OpenRouter, DeepSeek, Groq, xAI,
Together, Fireworks, Cerebras, Ollama, LM Studio, vLLM, llama.cpp (`providerPresets.ts:36-53`).
That single `??` chain is carrying at least four different vendor field names.

All five converge on `AgentEventSummary.reasoning?: string` (`agentTypes.ts:236`), attached only to
`message` events, plus a live `session.reasoningText` buffer.

### F1 — Gateway-routed Claude loses reasoning entirely (high confidence)

`gateway/wire.ts` has an "Anthropic Messages SSE fallback" branch that handles `message_start`,
`content_block_start` (tool_use only), `content_block_delta` (`text_delta`, `input_json_delta`) and
`message_delta`. It has **no `thinking_delta` case**, unlike `anthropicWire.ts:226` which does.

So a Claude model reached through a gateway that emits native Anthropic SSE streams its text and
tool calls correctly and drops every thinking block on the floor. Direct-Anthropic sessions show
thoughts; the same model through the gateway shows none. This is a straight omission, and the fix is
a few lines mirroring `anthropicWire.ts`.

### F2 — `reasoning` is a declared event type that is never emitted (high confidence)

`AgentEventType` includes `'reasoning'` (`agentTypes.ts:254`), but no code anywhere in `packages`
or `apps` emits `evt('reasoning', …)`. Two consumers still branch on it:

- `renderer/src/ai/aiSessionState.ts:79`
- `renderer/src/components/agent-details/AgentActivityFeed.tsx:240`

Reasoning rides on `message` events instead. Dead branches, and a trap for anyone building a common
display: they will look for a `reasoning` event and find none.

---

## 3. How reasoning is *requested* — and where it goes wrong

There is one normalized level, `ReasoningEffort = 'off' | 'low' | 'medium' | 'high'`
(`reasoningSupport.ts:11`), translated four ways:

| Target | Shape sent | Where |
| --- | --- | --- |
| Anthropic family | `thinking: { type: 'enabled', budget_tokens }` (direct) / `providerOptions.anthropic.thinking` (gateway) | `anthropicWire.ts:143`, `wire.ts:224` |
| Gemini family | `generationConfig.thinkingConfig: { thinkingBudget, includeThoughts: true }` | `geminiWire.ts:225`, `wire.ts:229` |
| Everything else | `reasoning_effort: 'low'\|'medium'\|'high'` | `wire.ts:235` |
| Bifrost | `reasoning: { effort }` | `bifrostAdapter.ts:15` |
| ACP CLI | `thought_level` config select, best-effort value match | `acpAgentHost.ts:389` |

Which shape is chosen depends on **model-id string sniffing** in `detectReasoningFamily`
(`reasoningSupport.ts:40`), explicitly independent of the provider routing the request.

### F3 — `gpt-6-*` is not recognized as an OpenAI reasoning model (high confidence)

```ts
function isOpenAiReasoningModel(normalized: string): boolean {
  return /^o[134](-|$)/.test(normalized) || normalized.includes('gpt-5');
}
```

Confirmed by running the actual predicates against real model ids:

```
gpt-6-luna        -> undefined      claude-sonnet-4-6          -> anthropic
gpt-6-astra       -> undefined      claude-sonnet-5            -> anthropic
gpt-6.1-sol       -> undefined      claude-opus-5.5            -> anthropic
gpt-5.6-luna      -> openai         claude-haiku-5.5           -> anthropic
glm-5.3           -> undefined      anthropic/claude-fable-5.1 -> undefined
qwen3.8-max       -> undefined      claude-fable-5             -> undefined
minimax-m3        -> undefined      gemini-3.8-flash           -> gemini
```

`gpt-6-luna`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol` all appear in Praxis's own reference rates
(`cliModelMetadata.ts:31`) but match neither branch, so `detectReasoningFamily` returns `undefined`.

Practically this is *almost* harmless on the HTTP path, because the `else` branch sends
`reasoning_effort` anyway — which OpenAI does accept on Chat Completions. But it means every
model-family-aware decision downstream treats GPT-6 as "not a reasoning model". Given `gpt-6-luna`
is one of the models asked about, this predicate is simply out of date.

### F4 — GLM, Qwen and MiniMax receive `reasoning_effort`, which is not their parameter (high confidence on GLM/Qwen, medium on MiniMax)

All three resolve to `undefined` from `detectReasoningFamily` (GLM explicitly asserted so in
`reasoningSupport.test.ts`), so they get `body.reasoning_effort`. Their documented parameters are:

- **Qwen 3.8 (Alibaba Model Studio)** — `enable_thinking: boolean` plus `thinking_budget: number`,
  both non-standard, passed via `extra_body` in the OpenAI SDK. `qwen3.8-max`, `qwen3.8-flash`,
  `qwen3.8-27b`, `qwen3.8-omni-flash` are *hybrid thinking mode, thinking enabled by default*;
  `qwen3.8-2.4t-a95b` is thinking-only. Response reasoning arrives in `delta.reasoning_content` and
  reasoning tokens in `completion_tokens_details.reasoning_tokens`.
  (alibabacloud.com/help/en/model-studio/deep-thinking, updated 2026-10-19)
- **GLM (Z.ai)** — the `thinking` object is GLM's own switch; Z.ai's docs do not document
  `reasoning_effort`. Reasoning arrives in `reasoning_content`.
- **MiniMax** — could not confirm the parameter name; `platform.minimax.io` docs did not render in
  this session. MiniMax models do emit `reasoning_content`, which the shared parser handles.

Note Praxis never sends `enable_thinking`, `thinking_budget`, or a GLM `thinking` object anywhere
(`grep` across `packages/core/src` returns nothing). Because Qwen 3.8 hybrid models default thinking
*on*, `qwen3.8-max` probably still returns `reasoning_content` and displays fine. But the reasoning
**effort slider has no effect on it** — the level the user picks is sent to a parameter the server
ignores. Same for GLM. That is a silent control failure, not just a display one.

### F5 — Praxis sends a thinking shape Anthropic now rejects with HTTP 400 (high confidence)

`isAnthropicReasoningModel` matches `(^|-)(opus|sonnet|haiku)-[4-9]`. That range covers
`claude-sonnet-4-6` **and** `claude-sonnet-5`, `claude-opus-5.5`, `claude-haiku-5.5` — all of which
are in Praxis's own rate table (`cliModelMetadata.ts:38-39`).

Per Anthropic's current docs: extended thinking (`thinking.type: "enabled"` with `budget_tokens`) is
**deprecated on Claude 4.6** (requests still succeed) and **Claude 4.7 and later reject it with a 400
error**. The replacement is `thinking: { type: "adaptive" }` with depth controlled by
`output_config: { effort: … }` — which maps onto Praxis's existing `ReasoningEffort` almost exactly.

This is reachable in normal use, not hypothetical: the model list is fetched live from Anthropic's
own Models API (`modelCatalog.ts:137-142`, `fetchAnthropicModels`), so whatever Anthropic currently
ships is what appears in Praxis's picker — including the 4.7+/5.x ids that reject `type: "enabled"`.

So selecting any effort above `off` on a current Claude model through Praxis produces a failed
request. And a behavioural difference matters for display: adaptive thinking means Claude decides
*whether* to think, and "at lower effort settings it may skip thinking entirely on easy inputs" —
i.e. an empty thought block becomes a legitimate normal outcome, not a failure.

### F6 — `claude-fable` is not detected as Anthropic (high confidence)

`claude-fable-5` and `claude-fable-5.1` are in `REFERENCE_RATES` and normalized by
`canonicalCliModelId`, but `fable` is absent from the `(opus|sonnet|haiku)` alternation, so a
gateway-routed `anthropic/claude-fable-5` receives `reasoning_effort` instead of an Anthropic
`thinking`/`adaptive` shape.

### F7 — Anthropic thinking is a *summary*, not a chain of thought (medium-high confidence)

Anthropic's own example labels the block `Thinking summary: {block.thinking}`, and there is a
`display` parameter controlling thinking visibility. Qwen, GLM, DeepSeek and MiniMax return the
actual raw chain of thought, often in the model's own language (Qwen's documented example reasons in
Chinese for a Chinese prompt).

This is the deepest problem for a "common display": the same widget will contain a curated English
summary from Claude, a raw stream-of-consciousness from Qwen possibly in Chinese, interleaved
thoughts from Gemini, and nothing at all from GPT-6. A common display can normalize the *container*
but cannot normalize the *content character*.

---

## 4. What each model actually returns

| Model / provider | Reasoning text returned? | Wire field | Effort control Praxis sends | Correct control param | Net effect in chat pane |
| --- | --- | --- | --- | --- | --- |
| **`gpt-6-luna`**, `gpt-6-astra`, `gpt-6.1-sol` (openai) | **No — never.** Reasoning items are opaque; docs: "the API does not return their reasoning text" | — (count only, `output_tokens_details.reasoning_tokens`) | `reasoning_effort` (via else branch) | `reasoning.effort`; Responses API recommended | **Thought block always empty.** Only token count is knowable, and Praxis does not parse it (F8) |
| **`gpt-6-*` via `codex-cli` (ACP)** | Yes — Codex surfaces thought chunks | `agent_thought_chunk` | `thought_level` select | same | **Thought block populated.** Same model, opposite display, depending on route |
| **`gpt-5.5` / `gpt-5.6-*` (openai)** | No over HTTP; interleaved thinking exists but is not exposed | — | `reasoning_effort` ✓ | same | Empty over HTTP; populated via `codex-cli` |
| **`qwen3.8-max/flash/27b`** (alibaba presets) | **Yes**, raw CoT, enabled by default | `delta.reasoning_content` ✓ handled | `reasoning_effort` ✗ ignored | `enable_thinking`, `thinking_budget` | Populated regardless; **slider does nothing** (F4) |
| **`qwen3.8-2.4t-a95b`** | Yes, thinking-only, cannot be disabled | `reasoning_content` | `reasoning_effort` ✗ | — | Always populated; `off` cannot turn it off |
| **`glm-5.3` / `glm-5.3-flash`** (z-ai) | Yes | `reasoning_content` ✓ | `reasoning_effort` ✗ | GLM `thinking` object | Probably populated; **slider does nothing** (F4). Asserted `undefined` family in `reasoningSupport.test.ts` |
| **`minimax-m3`** (minimax preset) | Likely yes | `reasoning_content` ✓ | `reasoning_effort` (unverified) | unverified — docs unreachable | Parameter unconfirmed; response field is handled |
| **Claude 4.7+ / 5.x** (`anthropic` direct) | n/a | — | `thinking.type:'enabled'` ✗ **HTTP 400** | `thinking:{type:'adaptive'}` + `output_config.effort` | **Request fails** when effort > off (F5) |
| **Claude 4.6** (`anthropic` direct) | Yes — *summarized* thinking | `delta.thinking` ✓ | `thinking.type:'enabled'` (deprecated, still works) | adaptive | Populated, with a summary rather than raw CoT (F7) |
| **Claude via `vercel-gateway`** | Depends on SSE dialect | native Anthropic SSE → **dropped** (F1); OpenAI-dialect → `reasoning_content` | `providerOptions.anthropic.thinking` | same | **Reasoning silently lost** if gateway passes through native Anthropic SSE |
| **Claude Code (`claude-code-cli`, ACP)** | Yes | `agent_thought_chunk` | `thought_level` select, best-effort match | agent-dependent | Populated; effort applies only if the agent advertises `thought_level` (`acpAgentHost.ts:396` — otherwise it keeps its own default) |
| **Gemini 2.5 / 3.x** | Yes, interleaved | `part.thought === true` ✓ | `thinkingConfig` ✓ correct | same | Populated — the only family whose request shape is fully right |
| **DeepSeek / Kimi / Groq / OpenRouter** | Yes (varies) | `reasoning_content` ✓ | `reasoning_effort` (varies) | vendor-specific | Populated when the vendor emits `reasoning_content` |
| **Ollama / LM Studio / vLLM / llama.cpp** | Model-dependent | `reasoning_content` if the server relays it | `reasoning_effort` usually ignored | local server config | Usually empty; some local models emit `<think>` inline instead, which Praxis does not split out |

Two rows deserve emphasis for the display question:

- **`gpt-6-luna` over HTTP can never show thoughts.** Any common display must treat "empty" as a
  first-class state with a reason ("this model does not expose reasoning"), not as a missing feature.
- **The same GPT-6 model shows thoughts via `codex-cli` and none via `openai`.** Route, not model,
  drives the display — so the UI cannot infer emptiness from the model name.

### F8 — Reasoning token counts are parsed only on the ACP path (high confidence)

`TokenUsage.reasoningTokens` exists (`wire.ts:66`) and `vercelAgentService.ts:369` accumulates it,
but the shared gateway `noteUsage` helper reads only `input_tokens` / `output_tokens` /
`total_tokens` (and camelCase variants). `geminiWire.ts` reads `promptTokenCount`,
`candidatesTokenCount`, `totalTokenCount` but not `thoughtsTokenCount`. `anthropicWire.ts` does not
read `output_tokens_details.thinking_tokens`.

Only `acpAgentHost.ts:159` maps `usage.thoughtTokens` → `reasoningTokens`.

The chat pane renders this in a tooltip — `SessionChatThread.tsx:574` shows
`(${…reasoningTokens} reasoning)` when present. So **that part of the telemetry bar appears for
Claude Code / Codex sessions and never for any API session.** A concrete, visible per-model
difference in the same widget.

This matters extra for GPT-6: since the reasoning *text* is unavailable, the token *count* is the
only evidence that thinking happened at all — and it is exactly the one Praxis discards.

---

## 5. The display layer — four widgets, one string

`renderer/src/ai/chatThought.ts` and `chatTurns.ts` are genuinely good normalization:

- `collectThoughtRuns` groups consecutive reasoning-bearing assistant messages into one run, so a
  tool-using turn does not print a stack of near-identical "Thought process" cards.
- `mergeReasoningStep` handles **cumulative vs incremental** reasoning by prefix comparison — the
  documented reason is "Providers that accumulate per round-trip send a string that already contains
  every earlier piece." This is the one place that explicitly absorbs a provider difference.
- `isNarration` / `canFoldIntoThought` fold "Let me check the diff." into the thought block instead
  of the transcript, deliberately narrow (≤240 chars, no code fence/list/heading/table/question).

The problem is what sits *on top* of that:

| Surface | File | Widget | Label | Default | Extras |
| --- | --- | --- | --- | --- | --- |
| Settled chat | `SessionChatThread.tsx:479-518` | `<details>` → nested `<details>` | **"Thought"** | collapsed | tool-call list, caption `4m 2s · 3 tool calls`, "Show full reasoning" inner expander |
| Streaming chat | `SessionChatThread.tsx:708-721` | `<details>` | **"Thoughts"** | **open** | no caption, no tool list, `session-chat-streaming-text` |
| AI review | `AiReviewPage.tsx:335-337` | `<details>` | — | collapsed | no caption, no tool list |
| AI review (live) | `AiReviewPage.tsx:355-357` | `<details open>` | — | open | separate widget again |
| Agent timeline | `AgentActivityFeed.tsx:389` | sparkles marker + `agent-thought-disclosure` | — | — | different class namespace entirely |
| Assistant panel | `AssistantPanel.tsx` | **none** | — | — | has an effort *slider* (line 255) but never renders reasoning |
| Mobile | `mobileSessionProjection.ts:19,145` | projected | — | — | truncated to **4 000 chars** |

So the same reasoning string is shown by five different components with two different labels
("Thought" vs "Thoughts"), two different default-open behaviours, and a truncation that exists only
on mobile. **Nothing in the renderer branches on provider or model** — verified by grep for
`provider ===` across `SessionChatThread.tsx`, `chatThought.ts`, `chatTurns.ts` (no hits). The
inconsistency is structural, not conditional.

### F9 — The streaming widget and the settled widget disagree (high confidence)

Live turns render `session.reasoningText` — the whole-turn cumulative buffer — in an **open**
`<details>` labelled "Thoughts". When the turn settles, the same content re-renders from
`event.reasoning` inside a **collapsed** "Thought" with a nested "Show full reasoning" expander.

The user therefore watches reasoning stream in expanded, then watches it collapse and move one level
deeper into the DOM the moment the turn finishes. That is the single most visible per-turn jolt, and
it happens for every model that returns reasoning at all.

### F10 — Cumulative-vs-incremental is an accident of buffer lifetime, not a contract (medium-high confidence)

`task.reasoningBuffer` is reset per **turn** (`acpAgentHost.ts:905,1157`; `vercelAgentService.ts:635,759`)
but *not* per round-trip, and each round-trip emits a `message` event carrying the buffer's current
contents. Hence later round-trips' `reasoning` is a prefix-superset of earlier ones — exactly what
`mergeReasoningStep` compensates for.

That works, but it is undocumented at the type level: `AgentEventSummary.reasoning` says only
"Model reasoning/thinking generated during this turn." If any host ever reset the buffer per
round-trip, the display would silently change from merged to duplicated with no type error. A common
display should pin this contract down explicitly (e.g. "cumulative within a turn" or
"incremental, renderer concatenates") rather than leave four hosts to agree by coincidence.

---

## 6. Recommendation — what a common display needs

Ordered by value per unit of effort.

1. **One `<ThoughtBlock>` component, used by all five surfaces.** Takes
   `{ steps: string[], caption?: string, toolCalls?: ToolCallView[], streaming?: boolean,
   emptyReason?: 'none' | 'unsupported' | 'not-requested' }`. Kills F9 and the "Thought"/"Thoughts"
   split. The merging logic in `chatThought.ts` already produces exactly `steps` — keep it, promote
   it to the shared component's input.

2. **Define the empty state as first-class.** Most important single design decision. `gpt-6-*` over
   HTTP, Claude 4.7+ under adaptive thinking on an easy prompt, and any local model that does not
   relay `reasoning_content` all legitimately produce nothing. Render a reason, not a blank:
   "This model does not expose reasoning" / "No extended thinking on this turn" / "Reasoning was not
   requested". This cannot be inferred from the model name (F: same GPT-6 differs by route), so the
   host must say which case applies.

3. **Parse reasoning token counts on every wire.** `completion_tokens_details.reasoning_tokens`
   (OpenAI/Qwen), `output_tokens_details.thinking_tokens` (Anthropic), `thoughtsTokenCount`
   (Gemini). Fixes F8, and for GPT-6 it is the *only* available signal that thinking occurred — the
   one model family that most needs it is the one currently getting nothing.

4. **Add `thinking_delta` to the gateway's Anthropic SSE fallback.** Two-line-class fix for F1;
   currently gateway-routed Claude silently loses all reasoning.

5. **Migrate Anthropic to adaptive thinking.** `thinking: { type: 'adaptive' }` +
   `output_config: { effort }`, keeping `type: 'enabled'` only for 4.5/4.6. Fixes F5, which is a
   hard 400 on current Claude models. Map `ReasoningEffort` → `output_config.effort` directly; the
   value sets already agree.

6. **Fix the family predicates.** Add `fable` to `isAnthropicReasoningModel` (F6) and `gpt-6` to
   `isOpenAiReasoningModel` (F3). Both are in Praxis's own rate table already.

7. **Send the vendor's real effort parameter.** `enable_thinking` + `thinking_budget` for Qwen
   presets; GLM's `thinking` object for z-ai. Fixes F4 — today the effort slider is inert for both,
   which is worse than no slider.

8. **Delete or implement `AgentEventType 'reasoning'`** (F2). Preferably delete, and document that
   reasoning rides on `message`.

9. **Pin the cumulative contract** (F10) in `AgentEventSummary.reasoning`'s doc comment and add a
   test that fails if a host ever emits incremental instead.

10. **Align mobile truncation** — 4 000 chars (`mobileSessionProjection.ts:19`) means a long Qwen
    chain of thought is silently cut while desktop shows it all. Either raise it or mark the
    projection as truncated so the UI can say so.

---

## 7. What I could not verify

- **No live API responses.** Every response-shape claim is from vendor documentation or Praxis's own
  parser code. Nothing was captured from a real stream in this session.
- **MiniMax parameter names** — `platform.minimax.io/docs` did not render; `minimax-m3`'s exact
  thinking switch is unconfirmed (marked medium confidence in §4).
- **GLM `thinking` request object** — `docs.z.ai` API reference pages returned 404 for every path I
  tried; the GLM row is inferred from Praxis's own test asserting `glm-5.3` → `undefined` family plus
  the confirmed `reasoning_content` response field.
- **Anthropic `display` parameter semantics** — the thinking overview page rate-limited partway
  through; the summary-vs-raw claim (F7) rests on Anthropic's `Thinking summary:` example and the
  documented existence of `display`, not on a full reading of that page.
- **Whether `qwen3.8-max` defaults thinking on through Praxis's specific preset endpoints** — the
  `coding-intl.dashscope.aliyuncs.com` Coding Plan endpoint may behave differently from the
  `compatible-mode/v1` endpoint the docs describe.

---

## 8. Implementation status (branch `fix/common-reasoning-display`)

Recommendations 2–6, 8 and 9 are implemented; 1 is implemented for the chat pane and both
AI-review surfaces but two other surfaces still use their own widget; 10 turned out to be already
satisfied; 7 is deliberately not implemented. Verified against Anthropic's, OpenAI's and Alibaba's
published docs during implementation — two findings changed what was built.

| # | Recommendation | Status |
| --- | --- | --- |
| 1 | One `<ThoughtBlock>` for all surfaces | **Partial** — `renderer/src/ui/ThoughtBlock.tsx` now serves settled chat, streaming chat and both AI-review surfaces (4 call sites, F9 killed). Two surfaces still use their own widget: the agent timeline (`AgentActivityFeed.tsx:400`, label "Reasoning / Thought Process") and the Assistant panel (`AssistantPanel.tsx:255` has an effort slider but renders no reasoning at all). See "Remaining surfaces" below |
| 2 | Empty state as first-class | **Done** — `thoughtDisplay.ts` + `AgentSessionRecord.reasoningAvailability`, stamped host-side |
| 3 | Parse reasoning token counts on every wire | **Done** — `wire.ts` (4 call sites), `geminiWire.ts` |
| 4 | `thinking_delta` in the gateway Anthropic fallback | **Done** — `wire.ts`, with a test |
| 5 | Migrate Anthropic to adaptive thinking | **Done** — `anthropicThinkingMode`/`anthropicThinkingConfig`, both request builders |
| 6 | Fix the family predicates (`fable`, `gpt-6`) | **Done** — plus `mythos`, verified against every id in the docs' table |
| 7 | Send the vendor's real effort parameter (Qwen/GLM/MiniMax) | **Not done — see below** |
| 8 | Delete the dead `'reasoning'` event type | **Done** — removed from `AgentEventType`; `git log -S` confirms it was never emitted |
| 9 | Pin the cumulative contract | **Done** — documented on `AgentEventSummary.reasoning` |
| 10 | Align mobile truncation | **Already satisfied** — `boundedText` inserts a visible `[…content truncated for mobile…]` marker, and `mobileSessionProjection.test.ts:91` asserts it |

### New finding — `display` defaults to `omitted` on Claude 4.7+ (§F5 addendum)

Migrating to `thinking: {type: 'adaptive'}` alone would **not** have fixed the chat pane. Anthropic's
docs state `display` defaults to `"omitted"` on Claude Fable 5.1, Mythos 5.1, Fable 5, Mythos 5,
Opus 5.5, Opus 5, Sonnet 5.5, Sonnet 5, Opus 4.8, Opus 4.7, Mythos Preview and Haiku 5.5 — thinking
blocks come back with an empty `thinking` field. The request would have succeeded, the reasoning
tokens would have been billed, and the pane would still have shown nothing.

So adaptive mode always sends `display: 'summarized'`. Extended mode deliberately does not: the same
docs give `"summarized"` as the default on 4.6 and earlier, so adding it there would be noise.

Behavioural note that matters for recommendation 2: adaptive thinking means Claude *decides* whether
to think, and "at lower effort settings it may skip thinking entirely on easy inputs". An empty
thought block is therefore a legitimate normal outcome on current Claude models too — not only on
GPT-6. That is precisely why the empty state needed a stated reason.

### Why recommendation 7 was not implemented

Qwen's parameters are now verified (`enable_thinking`, `thinking_budget` range 1–32768, passed via
`extra_body`), but the docs also undercut the blanket fix the report proposed:

- `qwen3.8-omni-flash` is documented as *"Adjust thinking effort via `reasoning_effort`"* — i.e. the
  parameter Praxis already sends is the **correct** one for that model. Switching it to
  `enable_thinking` would break it.
- `qwen3.8-2.4t-a95b` is thinking-only and *"cannot be disabled"*, so honouring `off` by sending
  `enable_thinking: false` would be rejected or ignored.

So the correct mapping is **per model**, not per provider — and these are custom presets
(`custom:alibaba-model-studio`, `custom:minimax`, `z-ai`), where a user may point the endpoint at any
model. GLM's `thinking` object and MiniMax's switch remain unverified (`docs.z.ai` reference paths
404; `platform.minimax.io` did not render), so there is no way to confirm those two at all.

Sending a guessed parameter is worse than the current behaviour: today the slider is inert, which is
a visible no-op; a wrong parameter can silently disable thinking on a model that needs it, or cause a
request failure. Left as a follow-up needing either per-model metadata or a live probe.

### Remaining surfaces not yet unified

The shared component exists and is proven by four call sites, but two surfaces are still outside it:

- **Agent timeline** (`AgentActivityFeed.tsx:400`) keeps its own `<details class="agent-thought-disclosure">`
  and its own label, "Reasoning / Thought Process". It is a different visual context (a timeline card
  with a sparkles marker and a timestamp), so unifying it means passing the timeline's marker and
  timestamp in as the block's caption/extras rather than swapping the widget outright.
- **Assistant panel** (`AssistantPanel.tsx`) offers a reasoning-effort slider at line 255 but never
  renders the reasoning that slider requests. This is the one surface where a control exists with no
  corresponding output, so it is the more user-visible gap of the two.

Neither blocks the session chat pane, which is what the original request was about; both are left as
follow-ups because each needs a design decision (what the timeline card and the assistant card look
like) rather than a mechanical replacement.

### Test and verification status

- Core: **1617 tests, 0 failures** (`npm run test:core`). Was 1611 at baseline; +6 new.
- Renderer units: **41 pass** (`tests/`, including the new `thoughtDisplay.test.ts`).
  `tests/modelCuration.test.ts` fails to load on a clean tree too (extensionless import under
  `--experimental-strip-types`) — pre-existing, excluded from the run.
- Typechecks: core, renderer and main all clean. `vite build` succeeds, which also proves the
  renderer's types-only-from-core rule holds for the new files.
- E2E (`--project=functional`): `aiThoughtGrouping`, `aiCliAgentHost`, `standaloneConversations`,
  `workflowRunWorkspace`, `easymode`, `aiTicketReview`. Remaining failures —
  `aiThoughtGrouping:190` ×2, `aiTicketReview` ×3, `easymode:71` — reproduce identically on a
  stashed clean tree, so they are pre-existing. `themes` 50/50 and `theme-regressions` 1/1 pass.
- **No live provider calls.** Request-shape changes are verified against vendor documentation, not
  captured traffic; a real API key would be the only way to confirm them end to end.

### One bug the new tests caught

Adding `reasoningTokens` to `noteUsage` initially covered only three of its four call sites. The
missed one — the top-level `evt.usage` chunk — is the *primary* OpenAI-compatible path, because the
final usage chunk carries no `choices` at all and is read before the choice guard. A new test
asserting the OpenAI-shaped breakdown failed until it was fixed, so the Qwen/GLM/DeepSeek reasoning
count would have been dropped silently.

## 9. Visual verification (added after the implementation)

The §8 claims above are backed by screenshots of the real renderer, driven against the in-process
gateway mock by `main/e2e/aiThoughtDisplayVerification.spec.ts`. Reasoning is streamed as
OpenAI-compatible `delta.reasoning_content` chunks — the exact field `gateway/wire.ts:669` reads to
yield `thought_delta` — so the captures are the shipped UI, not a fixture. The mock gained two
opt-in options for this (`reasoning`, and `usage.completion_tokens_details`); both default to
absent, so no existing caller changes behaviour. Evidence lives in
`.praxis/session-artifacts/thought-display/`:

| Capture | What it shows |
| --- | --- |
| `01-streaming-open.png` | Live turn: the widget open by default, label **"Thought"**, reasoning streaming in the nested expander. |
| `02-streaming-block.png` | The same block in isolation, mid-stream. |
| `03-settled-collapsed.png` | The turn it settles into: **same widget, same label**, collapsed to a caption with duration and telemetry. No relabel to "Thoughts", no DOM-level move — the §F2 jolt is gone. |
| `04-settled-expanded.png` | The settled block expanded: full reasoning above the reply, behind one nested expander. |
| `05-settled-reasoning.png` | The nested reasoner open on the settled turn. |
| `06-empty-opaque.png` | `gpt-6-luna` over `openai`: the first-class empty state, "This model doesn't return reasoning text." The host stamped `reasoningAvailability: 'opaque'` — asserted in the spec, not assumed. |
| `07-empty-opaque-settled.png` | The same session settled: the empty block is a live-turn affordance only, so history stays uncluttered. |
| `08-empty-not-requested.png` | `reasoningEffort: 'off'`: distinct copy, "Reasoning wasn't requested for this turn." — the two empty cases are not conflated, and the spec asserts the wire carried no `reasoning_effort`. |

The spec also asserts the §8 F4 fix end to end: the `reasoning_tokens` count from the usage chunk
reaches the telemetry tooltip's `title`, which is the only evidence of thinking for a route whose
text never arrives.

Two failures in the neighbouring `aiThoughtGrouping.spec.ts:190` pair (token-total assertions)
reproduce with this branch's mock change stashed, so they are pre-existing and unrelated to the
widget.
