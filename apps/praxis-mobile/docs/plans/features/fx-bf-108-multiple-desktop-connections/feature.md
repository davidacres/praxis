---
id: FX-BF-108
type: Feature
status: Backlog
---

# FX-BF-108: Multiple desktop connections

**Type:** Feature
**Status:** Backlog
**Priority:** High
**Model:** gpt-6.1-sol
**Created:** 2026-10-05

## Outcome

One phone can retain named, independently trusted Praxis desktops, switch safely between them, and later observe their work together. Deliver local multi-desktop use first; concurrency and notifications must not delay it.

## Scope and current baseline

The active workspace contains Flutter implementation under lib/, despite its praxis-mobile path. Implement here; consult the Expo reference for existing wording/behaviour where available. Today connection.dart stores one HostConfiguration and one cached appearance; ConnectScreen loads it automatically; AppStore owns one connection. No protocol change is assumed for basic multiple pairings: verify independent desktop authorisation with two real hosts.

| Area | First release contract |
| --- | --- |
| Desktops screen | Sidebar and offline entry points; Add desktop, select, rename/reset nickname, repair and forget |
| Identity | Stable saved entry; host ID plus pinned public key; nickname/IP is never an authentication identity |
| Naming | Local nickname preferred over reported name; fallback to address; duplicate names visibly disambiguated |
| Pairing | Save only authenticated successful pairing; same identity updates its entry; changed key requires explicit pairing |
| Startup | Reconnect last selected desktop; neutral picker if none; failure offers Retry or Switch without silent fallback |
| Switching | One active desktop; stale callbacks cannot update another; desktop-side work continues |
| State | Project/theme/drafts host-scoped; phone key and display size global; pending approvals revalidated |
| Forget | Confirm named local removal; other desktops retained; desktop-side grant revoked separately |
| Later | Concurrent observation, combined attention/activity, host-scoped notifications and deep links |

## Priority policy and story map

**High = P1:** required for the first release, including data isolation, migration and visual/device verification. **Medium = P2:** later foreground concurrency and combined views, after first-release qualification. **Low = P3:** optional notifications after delivery infrastructure is qualified. Priority orders ready work; dependencies always take precedence. Do not downgrade verification to optional work. Board statuses are Backlog/Done; delivery stage is separate from status.

| Story | Outcome | Priority | Delivery | Hard dependencies |
| --- | --- | --- | --- | --- |
| [FX-BE-161](stories/fx-be-161-saved-desktop-registry/story.md) | Saved desktop registry and migration | High | First release | None |
| [FX-BE-162](stories/fx-be-162-safe-desktop-switching/story.md) | Safe desktop switching and reconnection | High | First release | FX-BE-161 |
| [FX-BE-163](stories/fx-be-163-desktop-picker-and-names/story.md) | Desktop picker and connection naming | High | First release | FX-BE-161, FX-BE-162 |
| [FX-BE-164](stories/fx-be-164-add-repair-forget-desktops/story.md) | Add repair and forget desktop pairings | High | First release | FX-BE-161, FX-BE-162, FX-BE-163 |
| [FX-BE-165](stories/fx-be-165-desktop-scoped-drafts-and-preferences/story.md) | Desktop-scoped drafts projects and appearance | High | First release | FX-BE-161, FX-BE-162 |
| [FX-BE-166](stories/fx-be-166-first-release-qualification/story.md) | First release qualification and visual evidence | High | First release | FX-BE-162, FX-BE-163, FX-BE-164, FX-BE-165 |
| [FX-BE-167](stories/fx-be-167-concurrent-desktop-observation/story.md) | Concurrent desktop observation and lifecycle | Medium | Later stage 2 | FX-BE-166 |
| [FX-BE-168](stories/fx-be-168-combined-attention-and-activity/story.md) | Combined attention and activity across desktops | Medium | Later stage 2 | FX-BE-167 |
| [FX-BE-169](stories/fx-be-169-multi-desktop-notifications/story.md) | Host-scoped notifications and deep links | Low | Later stage 3 | FX-BE-168, FX-BE-086 |

## Dependencies

FX-BE-076, FX-BE-077, FX-BE-080, FX-BE-081, FX-BE-083.

## Existing integration boundaries

These existing stories supply pairing, reconnect, shell, continuation and request-specific decisions. Their physical-device evidence remains relevant; no helper test substitutes for it. FX-BE-079 is required only for relay-specific acceptance; FX-BE-086 owns notification delivery and gates FX-BE-169. Neither is a first-release LAN dependency. New internal edges are listed in each story and task; do not make a feature depend on its own children.

## Delivery and dependency order

| Stage | Sequence | Exit gate |
| --- | --- | --- |
| First release | 161 → 162; 163 and 165 can follow in parallel; 164 follows picker; 166 qualifies all | Two real hosts, migration, isolation, pairing, draft restore and physical-device visual evidence |
| Later stage 2 | 167 → 168 | Concurrent resource budget and independent failure recovery; host-attributed aggregate views/actions |
| Later stage 3 | 168 + existing 086 → 169 | Real notification delivery, privacy settings and safe host-specific cold/warm routing |

## Subagent and model recommendations

Recommendations are engineering judgment, not a claim that another provider cannot do the work. Prefer OpenAI through the configured Codex provider for this codebase; verify actual provider/model availability before assigning. No implementation agents are launched by this plan.

| Assignment | Provider / model | Reasoning | Delegation boundary |
| --- | --- | --- | --- |
| Lead: registry contracts and integration | OpenAI / gpt-6.1-sol | High | Freeze APIs and own shared-file integration; one owner for store.dart |
| Switching/race review and later concurrent supervisor | OpenAI / gpt-6-astra | High | Most demanding identity/lifecycle reasoning; independent review plus focused implementation |
| Picker/naming/pairing UI | OpenAI / gpt-6.1-sol | Medium | Separate UI files after registry/switch contracts; lead integrates shared store changes |
| Draft/preferences repository | OpenAI / gpt-6.1-sol | High | Parallel with UI after 161/162; avoid overlapping store.dart edits |
| Focused fixtures, index maintenance, evidence inventory | OpenAI / gpt-6-luna | High | Clear bounded deliverables; lead reviews tests and documents |
| Visual/device qualification | OpenAI / gpt-6.1-sol | High | Agent needs actual simulator/device tooling; serialize shared device control |
| Notification identity/routing review | OpenAI / gpt-6-astra | High | Review cross-host click/approval boundaries; Sol can implement adapter/UI work |

Use isolated branches/worktrees or exclusive file ownership, explicit task IDs and dependency gates. A practical team is one lead plus a UI worker and a storage/test worker. Parallel test-harness work may start once contracts are fixed; qualification cannot finish before product work. Do not assign simultaneous agents to store.dart, the same simulator, or shared pairing hosts. Provider auth, filesystem access and device permissions are independent of the model recommendation.

Sources checked 2026-10-05: [official model guidance](https://learn.chatgpt.com/docs/models) recommends GPT-6.1 Sol for complex coding, Luna for focused repeatable work and Astra for demanding work. [GPT-6 guide](https://developers.openai.com/api/docs/guides/latest-model) covers model family capabilities. Efforts and role allocation above are this plan's recommendations; recheck availability at execution time.

## Validation and visual verification

| Scope | Required evidence |
| --- | --- |
| Plan authoring | Real Praxis parser counts, IDs, types, priorities, status, parent association, dependency resolution and acyclic internal graph |
| Flutter logic/storage | flutter analyze; flutter test; fake secure storage; migration failures and malformed records; no identity regeneration |
| Transport/store | Two isolated real-protocol hosts; delayed reads/events; colliding session/project/run IDs; switch during streaming, reconnect, resume and approval |
| UI automation | Widget/integration journeys for picker/add/rename/forget/retry; Pressable accessibility labels; no pending action sent to wrong host |
| Visual inspection | Navigate each flow end to end; light/dark × compact/large; empty and multiple rows, long/duplicate names, loading/failure, keyboard, safe areas and screen-reader labels |
| Real integration | Two actual Praxis desktop instances, separate temp-backed profiles; phone pairs both, switches and performs a conversation/action; confirm each desktop's resulting state |
| Native release | flutter build ios --release --no-codesign; flutter build apk --release; signed/device builds as required for physical iOS and Android QR, LAN and background/resume evidence |
| Desktop changes if needed | Read area AGENTS.md; build core/renderer, copy renderer, build desktop, run test:desktop and visually inspect changed desktop UI; preserve folder regression gates if backend behaviour changes |
| Later concurrency | Three hosts, independent failure/backoff, measured traffic/battery budget, platform suspension and accurate stale indicators |
| Later notifications | Physical iOS/Android delivery, cold/warm deep links, unavailable/forgotten/revoked host, duplicate request IDs and mute/privacy checks |

Store useful evidence under .praxis/session-artifacts/ with host labels, build/device details and scenario captions; publish artifact gadgets in handoff. Never retain secrets or pairing invitations in evidence. Inspect screenshots before accepting baseline changes. If visual testing yields no useful screenshot, state that explicitly. Simulator/stage evidence and physical real-desktop evidence must be distinguished. All test/host write paths use temp copies, never working-tree plans or Praxis identity files.

## Close conditions

First-release milestone closes only when FX-BE-161–166 are Done with their automated, visual and device evidence. This entire feature remains open until FX-BE-167–169 also close; later work is planned, not silently excluded. Each close records commands/results, device/build identity, observed host outcomes, useful artifacts and remaining limitations. No code, runtime builds or visual journey is claimed as completed by authoring this plan.

## Description

Canonical plan owner is this mobile workspace. Link companion desktop/relay stories only when implementation exposes independent deliverables; do not duplicate existing FX-BE-079/086 work or publish tracker issues without instruction.

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |


## Comments


