# FX-BE-182 interruption and recovery contracts

Frozen snapshot: `f4d13b336867a7a097537de2d29ab0dfdc958e43` for the first 19 cases; `cdc6ec507f7f2fee56bfa689e0f841b1e0b93ff1` for the TASK-483 section and every line link in this file. Runner: **node:test**. These **34 supplemental cases** comprise six expanded matrix cases, seven coordinator cases, three transition cases, two file repository cases and one production adapter case, plus the 15 TASK-483 cases below (twelve coordinator, one transition, one production adapter, one file-backed IPC recovery). They are outside the Playwright-only generator. IDs use SHA1(file + newline + exact runtime title), matching the existing catalog convention; the six matrix titles expand the parameterised test call at line 6. Existing identities are preserved.

## PT-1987AF34D2

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatRecovery.test.ts:6](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L6).
Title: **startup recovery matrix: dispatched=false, capability=text**.

**Given** a stored prepared attempt without dispatch intent, with text capability evidence and originating epoch origin.
**When** begin a replacement conversation epoch.
**Then** the turn becomes interrupted, the attempt retains epoch origin, and the input attempt state is unchanged. This is a pure transition fixture, not process crash injection.

## PT-53DCAD8E2A

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatRecovery.test.ts:6](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L6).
Title: **startup recovery matrix: dispatched=false, capability=tools**.

**Given** a stored prepared attempt without dispatch intent, with tools capability evidence and originating epoch origin.
**When** begin a replacement conversation epoch.
**Then** the turn becomes interrupted, the attempt retains epoch origin, and the input attempt state is unchanged. This is a pure transition fixture, not process crash injection.

## PT-BCBD52ADC9

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatRecovery.test.ts:6](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L6).
Title: **startup recovery matrix: dispatched=false, capability=opaque**.

**Given** a stored prepared attempt without dispatch intent, with opaque capability evidence and originating epoch origin.
**When** begin a replacement conversation epoch.
**Then** the turn becomes interrupted, the attempt retains epoch origin, and the input attempt state is unchanged. This is a pure transition fixture, not process crash injection.

## PT-4B8BB0CD9C

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatRecovery.test.ts:6](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L6).
Title: **startup recovery matrix: dispatched=true, capability=text**.

**Given** a stored running attempt with dispatch intent, with text capability evidence and originating epoch origin.
**When** begin a replacement conversation epoch.
**Then** the turn becomes interrupted, the attempt retains epoch origin, and the input attempt state is unchanged. This is a pure transition fixture, not process crash injection.

## PT-4D3E0D4EF1

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatRecovery.test.ts:6](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L6).
Title: **startup recovery matrix: dispatched=true, capability=tools**.

**Given** a stored running attempt with dispatch intent, with tools capability evidence and originating epoch origin.
**When** begin a replacement conversation epoch.
**Then** the turn becomes outcome_unknown, the attempt retains epoch origin, and the input attempt state is unchanged. This is a pure transition fixture, not process crash injection.

## PT-CDD30BA7A8

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatRecovery.test.ts:6](../../packages/core/src/ai/assistant/teamChatRecovery.test.ts#L6).
Title: **startup recovery matrix: dispatched=true, capability=opaque**.

**Given** a stored running attempt with dispatch intent, with opaque capability evidence and originating epoch origin.
**When** begin a replacement conversation epoch.
**Then** the turn becomes outcome_unknown, the attempt retains epoch origin, and the input attempt state is unchanged. This is a pure transition fixture, not process crash injection.

## PT-0AA1A09AEC

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:699](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L699).
Title: **recovered result imports atomically once with usage and original epoch**.

**Given** an outcome_unknown attempt with a matching final-result observation and a replacement conversation epoch.
**When** accept the same recovered result twice.
**Then** exactly one Recovered reply is appended, the turn completes and usageReferences equals [paid-once]. Token totals and transaction fault atomicity are not asserted.

## PT-3C03B20D14

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:712](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L712).
Title: **interrupted retry preserves predecessor and unknown retry requires informed evidence**.

**Given** interrupted and outcome_unknown attempts carrying reconciliation observation.
**When** reject missing acknowledgement and wrong evidence for the unknown attempt, then resolve retry with acknowledgement and observation.
**Then** two attempts remain, predecessor state is preserved, and the unknown predecessor contains decision evidence. The retry provider is a throwing fixture.

## PT-122958093E

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:730](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L730).
Title: **active cancellation remains cancelling until execution settles and records evidence**.

**Given** one active lead attempt whose adapter promise is held open.
**When** cancel the turn, then settle the adapter with uncommitted text.
**Then** the turn is cancelling before settlement, then completed with one reply and execution-settled-after-abort evidence. This does not prove a terminal cancelled state or actual runtime termination.

## PT-EFAC0E337F

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:752](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L752).
Title: **startup imports durable results once across repeated coordinator replacements: "restart result"**.

**Given** an outcome_unknown attempt with a durable final-result observation containing "restart result".
**When** initialize two replacement coordinators on the same in-memory repository.
**Then** provider invocation count stays zero, exactly one lead message with that text exists and the turn completes.

## PT-9C568AE082

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:752](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L752).
Title: **startup imports durable results once across repeated coordinator replacements: ""**.

**Given** an outcome_unknown attempt with a durable final-result observation containing "".
**When** initialize two replacement coordinators on the same in-memory repository.
**Then** provider invocation count stays zero, exactly one lead message with that text exists and the turn completes.

## PT-804A2C0AC4

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:766](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L766).
Title: **direct unknown-outcome retry requires informed resolution without dispatch**.

**Given** an outcome_unknown attempt and repository snapshot.
**When** call retryParticipant without resolving the unknown outcome.
**Then** the call rejects with the resolution/duplicate-risk requirement and the repository remains deeply equal to its prior snapshot; dispatch count is not separately asserted.

## PT-485FAE251E

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:74](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L74).
Title: **repeated startup retains originating attempt epoch and observation provenance**.

**Given** a dispatched attempt from epoch epoch.
**When** begin replacement epochs next and again.
**Then** the attempt and first observation retain epoch epoch, that observation names observing epoch next, and the turn remains outcome_unknown.

## PT-064522325E

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:87](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L87).
Title: **recovered imports reject foreign identity and retain cancellation fences**.

**Given** a recovered dispatched attempt with final-result evidence naming a foreign conversation.
**When** try importing it, correct the conversation identity, mark the turn cancelled and try importing again.
**Then** both imports throw fenced errors. Other identity dimensions and runtime tool callbacks are not varied.

## PT-D03716DB85

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:103](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L103).
Title: **pre-dispatch recovery requires exact durable result and imports only once**.

**Given** a prepared attempt without dispatch intent.
**When** reject ordinary completion, begin a replacement epoch, add exact final-result evidence, reject foreign conversation, turn, participant, attempt and epoch identities, reject the observing epoch as the import epoch, import with the originating epoch and try importing again.
**Then** the imported attempt completes and the second import throws duplicate or fenced; ordinary prepared completion is fenced.

## PT-0ECEA64537

Automation: **node:test**, [apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts:146](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L146).
Title: **startup evidence and recovered reply survive repeated durable epoch changes**.

**Given** a temporary file repository seeded with a prepared attempt, no dispatch intent and an exact durable final result.
**When** reload and initialize replacement coordinators twice, reopening the file after each.
**Then** one recovered reply and completed turn survive reload; observation preserves the originating epoch and has a distinct observing epoch. The fixture seeds evidence rather than crashing a process.

## PT-F7C98A1CDA

Automation: **node:test**, [apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts:32](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L32).
Title: **effective capability evidence is durable before runtime dispatch; evidence failure prevents launch**.

**Given** a production adapter with a scripted CLI tools runtime and prepared matching policy binding.
**When** first fail the runtime-identity evidence callback, then record evidence and execute again.
**Then** failed evidence prevents launch; successful callback observes toolCapable true before any launch, followed by exactly one tools invocation. Physical disk durability is supplied by the callback contract, not exercised here.

## PT-E116B00BE3

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:773](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L773).
Title: **startup imports a prepared attempt result without dispatching the provider**.

**Given** a prepared attempt with no dispatch intent and a durable final result with usage attribution.
**When** initialize two replacement coordinators against the same repository and invoke idempotent accept resolution.
**Then** exactly one reply and its usage reference are committed, dispatch intent remains absent and the provider is never invoked.

## PT-853EBCDC9F

Automation: **node:test**, [apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts:186](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L186).
Title: **repository validates observation epochs separately from immutable attempt epochs**.

**Given** persisted reconciliation evidence whose observing epoch differs from its attempt's originating epoch.
**When** reopen the repository, then separately corrupt the observing epoch and replace the originating epoch with the observer.
**Then** the valid record reloads with both epochs intact, while both corrupt records fail decoding.

## TASK-483 cancellation, retry and approval restoration

## PT-82B6E77B60

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts:39](../../packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts#L39).
Title: **cancel keeps completed replies, skips remaining members, cancels queued turns and leaves other conversations alone**.

**Given** an in-memory three-member conversation (dev, qa, lead) whose qa attempt is running with partial output, a queued follow-up turn in the same conversation, and a second conversation with its own turn.
**When** cancel the first turn while qa is still running.
**Then** the turn stays `cancelling` (not cancelled) because qa has not settled; dev stays completed with its reply retained; lead is skipped; the queued follow-up turn is cancelled; the other conversation's turn stays completed.

## PT-CC185BD61C

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts:68](../../packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts#L68).
Title: **cancel retains partial output as evidence and an unsettled tool becomes outcome_unknown**.

**Given** a single running attempt that has emitted partial output and keeps emitting after the abort signal, then throws.
**When** cancel the turn and wait for settlement.
**Then** the attempt and turn become `outcome_unknown` (not cancelled or failed), and both partial outputs, before and after abort, are kept as `partial_output` recovery evidence. "Tool" here is an adapter that never reports an outcome; no real tool runs.

## PT-591E3339A9

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts:88](../../packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts#L88).
Title: **retry appends one attempt for the failed member, keeps predecessors and resumes successors exactly once**.

**Given** a three-member turn where qa fails once after dev completes.
**When** try to retry the completed dev member, then retry qa.
**Then** retrying dev is rejected as a stale target; retrying qa appends attempt 2 (attempt 1 stays `failed`), dev keeps its single attempt, and lead runs exactly once after the retry commits. Execution order is dev, qa, qa, lead.

## PT-2A03F67EEF

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts:111](../../packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts#L111).
Title: **approval identity is recorded on the attempt, fenced, and resolvable only by its request id**.

**Given** a running attempt whose adapter reports runtime approval request `req-1`.
**When** resolve with a different request id, then with `req-1`.
**Then** the attempt enters `awaiting_approval` with `pendingApproval.runtimeRequestId = req-1`; the wrong id is rejected as a fenced resolution; resolving `req-1` lets the turn complete with the approval `resolved`.

## PT-4DA103C9B3

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts:131](../../packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts#L131).
Title: **an approval raised after cancel is rejected and the attempt is not reopened**.

**Given** a running attempt.
**When** cancel the turn, then have the adapter raise an approval request after the abort signal.
**Then** the late request is rejected as fenced, no `pendingApproval` is recorded, the attempt never enters `awaiting_approval`, and the turn settles `outcome_unknown`.

## PT-077F329D57

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts:153](../../packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts#L153).
Title: **completing while awaiting approval resolves the pending approval**.

**Given** an attempt that records approval `req-1` and then returns a reply without an explicit resolve callback.
**When** let the turn complete, then cancel it.
**Then** the attempt completes with the approval `resolved`, and the later cancel does not change it to invalidated.

## PT-CF23068423

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts:170](../../packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts#L170).
Title: **failing while awaiting approval invalidates the pending approval**.

**Given** an attempt that records approval `req-1` and then throws.
**When** let the turn fail.
**Then** the attempt is `failed` and its approval is `invalidated`.

## PT-AF00EAF3FB

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts:185](../../packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts#L185).
Title: **a superseding runtime request resolves the previous one before recording the next**.

**Given** an adapter that awaits, in order: record A, resolve A, record B, resolve B.
**When** the turn runs to completion.
**Then** immediately after B is recorded the attempt is `awaiting_approval` on B; the final approval is B, `resolved`. This proves coordinator ordering only when callbacks are awaited in sequence; it does not drive the production adapter's queue or `completeWithTools` (see finding in the TASK-483 report).

## PT-F4740014B7

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts:226](../../packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts#L226).
Title: **restart invalidates the approval and restores it on the same attempt only for a live matching request**.

**Given** a persisted snapshot where an attempt is `awaiting_approval` on `req-1` and the process stopped.
**When** start a replacement coordinator whose adapter lists a live request `req-1` for that same attempt.
**Then** the approval is `restored` on the original attempt with the new epoch recorded, no new attempt is created, an `approval_restored` update is emitted, no provider runs, and the attempt stays `outcome_unknown` so restoration never makes it look safe.

## PT-A64184151D

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts:240](../../packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts#L240).
Title: **without a live matching request the approval stays invalidated and is never transferred**.

**Given** the same crashed snapshot.
**When** restart six times: no listing hook, empty list, different request id, different attempt, a live request missing its attempt id, and a listing that throws.
**Then** in every case the approval is `invalidated`, the attempt is `interrupted` or `outcome_unknown`, there is still one attempt, no provider runs, and only `approval_invalidated` is emitted.

## PT-111CBBC363

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts:262](../../packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts#L262).
Title: **approval callbacks and restoration from a stale epoch are rejected**.

**Given** the crashed snapshot and the pure transition functions.
**When** resolve or record with a foreign epoch; after restart, resolve with the old epoch and restore with a wrong request id.
**Then** every call throws a fenced or cannot-be-restored error.

## PT-9E656E5B4B

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts:274](../../packages/core/src/ai/assistant/teamChatCancelRetryApproval.test.ts#L274).
Title: **an unknown-outcome retry needs acknowledgement and evidence and is marked as user-authorized**.

**Given** a restarted conversation whose attempt is `outcome_unknown` with recorded reconciliation evidence.
**When** try a plain retry, a resolve-retry without options, and one with a missing evidence id; then retry with duplicate-action risk acknowledged and the real evidence id.
**Then** the first three are rejected and no provider runs; the accepted retry records a `decision` evidence entry with provenance `user`, `retryKind: user-authorized-unknown`, the acknowledgement and the evidence id, appends a second attempt, runs the provider once and completes the turn.

## PT-B424123131

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatTransitions.test.ts:159](../../packages/core/src/ai/assistant/teamChatTransitions.test.ts#L159).
Title: **settleAttemptApproval acts only on a pending approval and is idempotent**.

**Given** attempts with no approval, a pending approval, and a second pending approval.
**When** settle or invalidate each, then repeat.
**Then** only a pending approval changes; a settled one is never re-settled (resolved stays resolved), and the second call returns false.

## PT-E16F79FB31

Automation: **node:test**, [apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts:316](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L316).
Title: **live approvals are reported only for the owning attempt while its session still awaits approval**.

**Given** the production adapter over scripted runtime session records: one session with two queued permission requests (event indexes 0 and 2), one other awaiting session, and one running session.
**When** list live approvals for each attempt as the head request is answered, the queue empties and the sessions vanish.
**Then** the owning attempt sees `s1:permission:0`, then `s1:permission:2` once the head is answered, then nothing; the identity equals the mobile permission surface's request id; running, unknown and vanished sessions report nothing. Session records are fixtures, not a live ACP runtime.

## PT-075F11B417

Automation: **node:test**, [apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts:277](../../apps/praxis-desktop/main/src/main/teamChatIpcRecovery.test.ts#L277).
Title: **startup restores a pending approval on its own attempt only for a live matching runtime request**.

**Given** a temporary team-chat file whose turn was left `awaiting_approval` by a coordinator that never settled.
**When** run startup recovery through `createTeamChatServices`, once with a live matching runtime request and once with none.
**Then** the file keeps one attempt with the original id; its approval is `restored` with the live request and `invalidated` without; `approval_restored` is emitted only in the live case and no provider runs.
