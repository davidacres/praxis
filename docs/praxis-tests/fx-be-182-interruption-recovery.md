# FX-BE-182 interruption and recovery contracts

Frozen snapshot: `5843c95e9b813738de067dbd6fa87dd92755200b`. Runner: **node:test**. These **17 supplemental cases** comprise six expanded matrix cases, six coordinator cases, three transition cases, one file repository case and one production adapter case. They are outside the Playwright-only generator. IDs use SHA1(file + newline + exact runtime title), matching the existing catalog convention; the six matrix titles expand the source loop at line 7. Existing identities are preserved.

## PT-1987AF34D2

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatRecovery.test.ts:7](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L7).
Title: **startup recovery matrix: dispatched=false, capability=text**.

**Given** a stored prepared attempt without dispatch intent, with text capability evidence and originating epoch origin.
**When** begin a replacement conversation epoch.
**Then** the turn becomes interrupted, the attempt retains epoch origin, and the input attempt state is unchanged. This is a pure transition fixture, not process crash injection.

## PT-53DCAD8E2A

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatRecovery.test.ts:7](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L7).
Title: **startup recovery matrix: dispatched=false, capability=tools**.

**Given** a stored prepared attempt without dispatch intent, with tools capability evidence and originating epoch origin.
**When** begin a replacement conversation epoch.
**Then** the turn becomes interrupted, the attempt retains epoch origin, and the input attempt state is unchanged. This is a pure transition fixture, not process crash injection.

## PT-BCBD52ADC9

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatRecovery.test.ts:7](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L7).
Title: **startup recovery matrix: dispatched=false, capability=opaque**.

**Given** a stored prepared attempt without dispatch intent, with opaque capability evidence and originating epoch origin.
**When** begin a replacement conversation epoch.
**Then** the turn becomes interrupted, the attempt retains epoch origin, and the input attempt state is unchanged. This is a pure transition fixture, not process crash injection.

## PT-4B8BB0CD9C

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatRecovery.test.ts:7](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L7).
Title: **startup recovery matrix: dispatched=true, capability=text**.

**Given** a stored running attempt with dispatch intent, with text capability evidence and originating epoch origin.
**When** begin a replacement conversation epoch.
**Then** the turn becomes interrupted, the attempt retains epoch origin, and the input attempt state is unchanged. This is a pure transition fixture, not process crash injection.

## PT-4D3E0D4EF1

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatRecovery.test.ts:7](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L7).
Title: **startup recovery matrix: dispatched=true, capability=tools**.

**Given** a stored running attempt with dispatch intent, with tools capability evidence and originating epoch origin.
**When** begin a replacement conversation epoch.
**Then** the turn becomes outcome_unknown, the attempt retains epoch origin, and the input attempt state is unchanged. This is a pure transition fixture, not process crash injection.

## PT-CDD30BA7A8

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatRecovery.test.ts:7](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L7).
Title: **startup recovery matrix: dispatched=true, capability=opaque**.

**Given** a stored running attempt with dispatch intent, with opaque capability evidence and originating epoch origin.
**When** begin a replacement conversation epoch.
**Then** the turn becomes outcome_unknown, the attempt retains epoch origin, and the input attempt state is unchanged. This is a pure transition fixture, not process crash injection.

## PT-0AA1A09AEC

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:539](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L539).
Title: **recovered result imports atomically once with usage and original epoch**.

**Given** an outcome_unknown attempt with a matching final-result observation and a replacement conversation epoch.
**When** accept the same recovered result twice.
**Then** exactly one Recovered reply is appended, the turn completes and usageReferences equals [paid-once]. Token totals and transaction fault atomicity are not asserted.

## PT-3C03B20D14

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:552](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L552).
Title: **interrupted retry preserves predecessor and unknown retry requires informed evidence**.

**Given** interrupted and outcome_unknown attempts carrying reconciliation observation.
**When** reject missing acknowledgement and wrong evidence for the unknown attempt, then resolve retry with acknowledgement and observation.
**Then** two attempts remain, predecessor state is preserved, and the unknown predecessor contains decision evidence. The retry provider is a throwing fixture.

## PT-122958093E

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:570](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L570).
Title: **active cancellation remains cancelling until execution settles and records evidence**.

**Given** one active lead attempt whose adapter promise is held open.
**When** cancel the turn, then settle the adapter with uncommitted text.
**Then** the turn is cancelling before settlement, then completed with one reply and execution-settled-after-abort evidence. This does not prove a terminal cancelled state or actual runtime termination.

## PT-EFAC0E337F

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:592](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L592).
Title: **startup imports durable results once across repeated coordinator replacements: "restart result"**.

**Given** an outcome_unknown attempt with a durable final-result observation containing "restart result".
**When** initialize two replacement coordinators on the same in-memory repository.
**Then** provider invocation count stays zero, exactly one lead message with that text exists and the turn completes.

## PT-9C568AE082

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:592](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L592).
Title: **startup imports durable results once across repeated coordinator replacements: ""**.

**Given** an outcome_unknown attempt with a durable final-result observation containing "".
**When** initialize two replacement coordinators on the same in-memory repository.
**Then** provider invocation count stays zero, exactly one lead message with that text exists and the turn completes.

## PT-804A2C0AC4

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:606](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L606).
Title: **direct unknown-outcome retry requires informed resolution without dispatch**.

**Given** an outcome_unknown attempt and repository snapshot.
**When** call retryParticipant without resolving the unknown outcome.
**Then** the call rejects with the resolution/duplicate-risk requirement and the repository remains deeply equal to its prior snapshot; dispatch count is not separately asserted.

## PT-485FAE251E

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:58](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L58).
Title: **repeated startup retains originating attempt epoch and observation provenance**.

**Given** a dispatched attempt from epoch epoch.
**When** begin replacement epochs next and again.
**Then** the attempt and first observation retain epoch epoch, that observation names observing epoch next, and the turn remains outcome_unknown.

## PT-064522325E

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:71](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L71).
Title: **recovered imports reject foreign identity and retain cancellation fences**.

**Given** a recovered dispatched attempt with final-result evidence naming a foreign conversation.
**When** try importing it, correct the conversation identity, mark the turn cancelled and try importing again.
**Then** both imports throw fenced errors. Other identity dimensions and runtime tool callbacks are not varied.

## PT-D03716DB85

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:87](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L87).
Title: **pre-dispatch recovery requires exact durable result and imports only once**.

**Given** a prepared attempt without dispatch intent.
**When** reject ordinary completion, begin a replacement epoch, add exact final-result evidence, reject foreign conversation, turn, participant, attempt and epoch identities, reject the observing epoch as the import epoch, import with the originating epoch and try importing again.
**Then** the imported attempt completes and the second import throws duplicate or fenced; ordinary prepared completion is fenced.

## PT-0ECEA64537

Automation: **node:test**, [apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts:115](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L115).
Title: **startup evidence and recovered reply survive repeated durable epoch changes**.

**Given** a temporary file repository seeded with a prepared attempt, no dispatch intent and an exact durable final result.
**When** reload and initialize replacement coordinators twice, reopening the file after each.
**Then** one recovered reply and completed turn survive reload; observation preserves the originating epoch and has a distinct observing epoch. The fixture seeds evidence rather than crashing a process.

## PT-F7C98A1CDA

Automation: **node:test**, [apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts:31](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L31).
Title: **effective capability evidence is durable before runtime dispatch; evidence failure prevents launch**.

**Given** a production adapter with a scripted CLI tools runtime and prepared matching policy binding.
**When** first fail the runtime-identity evidence callback, then record evidence and execute again.
**Then** failed evidence prevents launch; successful callback observes toolCapable true before any launch, followed by exactly one tools invocation. Physical disk durability is supplied by the callback contract, not exercised here.

## Prepared-result startup integration

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts).
Title: **startup imports a prepared attempt result without dispatching the provider**.

**Given** a prepared attempt with no dispatch intent and a durable final result with usage attribution.
**When** initialize two replacement coordinators against the same repository.
**Then** exactly one reply and its usage reference are committed, dispatch intent remains absent and the provider is never invoked.

## Originating and observing epoch validation

Automation: **node:test**, [apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts).
Title: **repository validates observation epochs separately from immutable attempt epochs**.

**Given** persisted reconciliation evidence whose observing epoch differs from its attempt's originating epoch.
**When** reopen the repository, then separately corrupt the observing epoch and replace the originating epoch with the observer.
**Then** the valid record reloads with both epochs intact, while both corrupt records fail decoding.
