# FX-BE-181 provider binding and context contracts

Frozen implementation: `531c908b5821ee4ea75f4b0a17548f026cb7e55d`. Runner: **node:test**. These 16 supplemental contracts cover the new Node registrations; the generated catalog covers the two new Playwright registrations. IDs use the existing SHA1(file + newline + exact title) convention. Supplemental contracts are checked separately, outside the repository catalog validator.

## PT-ACA148E624

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatBindings.test.ts:6](../../packages/core/src/ai/assistant/teamChatBindings.test.ts#L6).
Title: **every resolved compatibility dimension invalidates reuse and switching back stays fresh**.

**Given** a complete compatibility configuration and fresh binding list per dimension.
**When** resolve identical configuration, change each dimension, then switch back.
**Then** identical settings reuse the binding; each changed dimension makes a new ID; except participant changes, old status becomes invalid and switching back allocates a third binding.

## PT-9DCCCF8D27

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatContext.test.ts:15](../../packages/core/src/ai/assistant/teamChatContext.test.ts#L15).
Title: **reconstruction preserves history beyond legacy limits and excludes future input**.

**Given** 19 earlier user messages, a 4000-character early pinned decision, current input and queued future input.
**When** prepare reconstruction context.
**Then** 20 messages remain, early decision text is present, future text is absent, and the budget method is utf8-bytes-upper-bound.

## PT-0A0EAED4F7

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatContext.test.ts:22](../../packages/core/src/ai/assistant/teamChatContext.test.ts#L22).
Title: **mandatory overflow prevents dispatch rather than clipping**.

**Given** the same long fixture.
**When** prepare context with limit 10 and reserve zero.
**Then** TeamChatContextRequired is thrown; provider dispatch is not exercised.

## PT-86B267D61F

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatContext.test.ts:25](../../packages/core/src/ai/assistant/teamChatContext.test.ts#L25).
Title: **native coverage excludes delivered shared messages and own output**.

**Given** a native binding covering delivered m0, own output m1 and summarized m2.
**When** prepare native context.
**Then** 17 messages remain and the receipt excludes all three covered IDs.

## PT-A7F41C3F50

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatContext.test.ts:33](../../packages/core/src/ai/assistant/teamChatContext.test.ts#L33).
Title: **summary sources are validated and pinned corrections remain verbatim**.

**Given** the long fixture with m1 correcting m0 and a valid version-one summary.
**When** prepare context, corrupt one summary source, then prepare again.
**Then** the first receipt contains m0, m1 and current only, prompt includes the correction relation, and corrupted provenance removes the summary ID.

## PT-E4566B69A9

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatContext.test.ts:44](../../packages/core/src/ai/assistant/teamChatContext.test.ts#L44).
Title: **an earlier turn reply committed after a queued input remains eligible**.

**Given** a queued future input and a reply from a completed earlier turn committed at sequence 22.
**When** prepare the current turn context.
**Then** the receipt includes the late prior reply and excludes future input.

## PT-36D88646CB

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:445](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L445).
Title: **compatible members retain one binding each across turns and chats remain isolated; usage commits once**.

**Given** two in-memory conversations and a configured stub adapter returning duplicate usage references.
**When** submit dev/qa turns twice to the first chat and once to the second.
**Then** four attempts and two bindings exist in the first, four distinct binding IDs across chats, inputTokens is 2, references deduplicate and each result ID is marked as native output.

## PT-8322FDF906

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:466](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L466).
Title: **context overflow pauses before any main provider attempt**.

**Given** a coordinator without summarization and a dispatch counter.
**When** submit 40000 characters.
**Then** context_required is stored, zero attempts are created and execute is never called.

## PT-B3B7D355CB

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:476](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L476).
Title: **uncertain acceptance invalidates the binding and never automatically resends**.

**Given** a coordinator with an adapter throwing TeamChatAcceptanceUnknown.
**When** submit one turn and request participant retry.
**Then** outcome_unknown is stored, execute was called once, and retry rejects; binding invalidation itself is not asserted.

## PT-D453C7A90A

Automation: **node:test**, [packages/core/src/ai/assistant/teamChatCoordinator.test.ts:491](../../packages/core/src/ai/assistant/teamChatCoordinator.test.ts#L491).
Title: **bounded summarization has separate provenance and usage; summary failure dispatches no main prompt**.

**Given** 18 long historical messages, an early pin and stub summarization in success and failure modes.
**When** submit a 12000-character current request.
**Then** summary input stays within 16000 bytes; success retains the pin, stores summary source IDs and provenance, and separates summary inputTokens 100 from main 200; failure stores context_required and failed summary attempt without main dispatch.

## PT-45452EE422

Automation: **node:test**, [apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts:6](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L6).
Title: **dispatch consumes prepared context unchanged and preserves attempt usage**.

**Given** an injected dispatcher returning usage and one reference.
**When** execute a prepared 4000-character prompt.
**Then** dispatcher receives it unchanged and returned inputTokens 10 and reference attempt:a survive.

## PT-A5EB5F0D9C

Automation: **node:test**, [apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts:15](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L15).
Title: **missing context or pre-dispatch cancellation invokes no provider**.

**Given** a counting dispatcher.
**When** execute without context then with an already-aborted signal.
**Then** both calls reject and dispatcher count stays zero.

## PT-9091C3E855

Automation: **node:test**, [apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts:24](../../apps/praxis-desktop/main/src/main/teamChatExecutionAdapter.test.ts#L24).
Title: **current policy is revalidated immediately before provider dispatch**.

**Given** a valid binding with an obsolete digest and a prepare callback returning current configuration.
**When** execute prepared context.
**Then** policy-changed rejection occurs before any dispatcher call; production permission gates are not exercised.

## PT-ABE894C263

Automation: **node:test**, [apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts:124](../../apps/praxis-desktop/main/src/main/adapters/teamChatRepository.test.ts#L124).
Title: **provider bindings, summary provenance, usage and decision corrections survive reload in isolation**.

**Given** a temporary file repository containing bindings, sources, summary provenance and a decision correction.
**When** reload, mutate a returned copy and submit invalid source/state transactions.
**Then** delivered source, summary usage 10, summary attempt linkage and correction survive; returned binding mutation does not affect the repository; missing pinned source and invalid summary state reject.

## PT-1AE4FF6CEF

Automation: **node:test**, [packages/core/src/ai/acp/acpAgentHost.test.ts:593](../../packages/core/src/ai/acp/acpAgentHost.test.ts#L593).
Title: **durable ACP continuation sends only prepared context on native resume and reconstruction fallback**.

**Given** a temporary scripted ACP subprocess, prior session and distinct prepared reconstruction/continuation strings.
**When** continue with resume capability advertised and then absent.
**Then** captured prompt equals the native delta or full reconstruction respectively, record reports matching delivery mode and completes without legacy history appended.

## PT-CCDCE2367D

Automation: **node:test**, [packages/core/src/ai/aiSessionManager.test.ts:621](../../packages/core/src/ai/aiSessionManager.test.ts#L621).
Title: **durable ownership and negotiated context delivery persist without aliasing the caller**.

**Given** a completed session in an in-memory storage adapter.
**When** store ownership and native delivery, mutate caller ownership and reload manager.
**Then** attempt ID remains the original; after reload the ownership deeply equals the original (conversation, turn, participant, attempt, binding and epoch IDs), `providerSessionId` is absent, and context delivery remains native.
