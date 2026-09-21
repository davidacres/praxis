# Interactive chat gadgets

**Status:** Implemented (desktop) — see [FX-BF-036](plans/features/fx-bf-036-interactive-chat-gadgets/feature.md)
**Supersedes:** the provider-neutral choice-gadget proof (commit `6bbfcad`), now removed.

A gadget is a typed, interactive surface Praxis renders inside a chat response,
so a decision, a dataset or a change set can be presented as itself instead of
as prose the user has to translate back into a command.

## The path a gadget takes

```
provider / workflow text
  → parseChatBlocks       (host stamps scope + identity)
  → validateGadgetEnvelope (bounds, schema, secret redaction, capability)
  → renderer registry      (kind@version → component, else text fallback)
  → user action
  → scope + policy check   (host, project, session, work, workflow gate)
  → action ledger          (idempotency, correlation, evidence)
  → executor               (the service that already owns the side effect)
  → structured result
```

Everything before the renderer runs in the main process. The renderer never
mints a scope and never decides whether an action is allowed — it names a
session, a gadget and an action, and the host does the rest. That is what stops
a client retargeting an approval at another project.

## Asking for a gadget

Any provider or workflow stage asks the same way, by emitting a fenced block.
There is no adapter-specific contract, so Claude, Codex and Copilot all reach
gadgets identically:

````markdown
Here are the check results.

```praxis-gadget
{
  "kind": "choice",
  "payload": {
    "question": "Which provider should continue this work?",
    "options": [
      { "value": "claude", "label": "Claude" },
      { "value": "codex", "label": "Codex" }
    ]
  },
  "actions": [{ "actionId": "pick", "label": "Continue", "effect": "informational" }]
}
```
````

The producer chooses **what to ask**. It does not choose `scope`, `issuedAt`, or
its own authority — those are stamped host-side and overwritten if supplied.

### Kinds

`choice` · `confirmation` · `form` · `table` · `chart` · `progress` · `diff` ·
`artifact` · `handoff` · `conflict` · `approval`

An unknown kind is not an error: it degrades to the envelope's `fallbackText`,
which the host derives when the producer omits it.

### Actions and gates

| `effect` | Meaning | Gate |
| --- | --- | --- |
| `informational` | Records a decision; no service is called | none |
| `mutating` | Changes state | **required** |
| `approval` | Opens a workflow gate | **required** |

A `mutating` or `approval` action that names no gate is refused at validation.
A gadget cannot grant itself authority, and the gate is checked against the
service that already owns it — a gadget is never a second approval path. For a
real workflow run this is concrete: a run's controller session is offered an
`approval` gadget for each node awaiting a person (`syncApprovalGadgets`,
`packages/core/src/workflows/workflowApprovalGadgets.ts`), and confirming it
calls the same `approveStage` the run monitor's own Approve button uses — a
stale or already-settled node is refused rather than approved blind.

An `informational` action on a `choice` gadget is the one case where the
recorded answer is also reported to the agent: the desktop renderer sends it
as an ordinary follow-up turn (the same path a typed reply takes) once the
session is idle, so a choice the agent asked for actually reaches its next
turn instead of only living in the ledger. `confirmation`/`form` answers are
not echoed this way — they routinely pair with a `mutating`/`approval` action
that already reaches a real service through its own gated executor, and
echoing those too would risk a second, uncoordinated notification path.

## Safety properties

- **Bounded.** Every collection has a ceiling (`limits.ts`). Data collections
  (rows, points, files) are trimmed and flagged `truncated`; control collections
  (choice options, actions) are *refused*, because silently dropping the 25th
  option would hide a decision the user was meant to be offered.
- **Redacted.** Every string in a payload is scanned for credential shapes and
  masked before it is rendered or persisted. The envelope is flagged `redacted`
  and the UI says so.
- **Scoped.** Host, project, session and work are pinned at issue time. A
  mismatch is refused, not applied to whatever is open now.
- **Idempotent.** Submissions are keyed. The same key with the same answer
  replays the recorded outcome; the same key with a *different* answer is a
  conflict. A refused submission never consumes its key, so a user denied while
  a gate was shut can retry once it opens.
- **Evidenced.** Each ledger record copies what was asked — the prompt, the
  action's label, its effect and its gate — so an audit does not depend on the
  gadget or the transcript still existing.
- **Never silent.** Every failure path produces a visible block with a reason.

## Lifecycle

`active` is the only state that accepts input. State is *derived* on read from
the envelope, the clock, the ledger and connectivity, so a client that
reconnects computes the same answer the host would.

Precedence: `revoked` → a recorded answer (`completed`/`submitted`) →
`superseded` → `expired` → `disconnected` → `active`. A recorded answer
outranks expiry deliberately: relabelling a decision somebody made as "expired"
reads as though their answer was thrown away.

## Where the code lives

| Path | What |
| --- | --- |
| `packages/core/src/ai/gadgets/contracts.ts` | Types, kinds, versions |
| `…/validation.ts`, `limits.ts`, `redaction.ts` | Bounds, schema, masking |
| `…/fallback.ts` | Plain-text rendering of every kind |
| `…/blockParser.ts` | Provider text → blocks |
| `…/lifecycle.ts`, `scope.ts`, `actionLedger.ts` | State, authorization, evidence |
| `…/gadgetService.ts` | The pipeline above, in one place |
| `…/fixtures.ts` | Deterministic examples of every kind and failure |
| `apps/praxis-desktop/main/src/main/gadgetIpc.ts` | IPC + the executor |
| `apps/praxis-desktop/renderer/src/ai/gadgets/` | Registry + the 11 renderers |

The renderer imports **types only** from core, and mirrors the two constants it
needs in `gadgetContract.ts` — see AGENTS.md on why a value import there fails
only at `vite build`.

## Adding a kind

1. Add it to `GADGET_KINDS` and give it a payload type in `contracts.ts`.
2. Add a validator to `PAYLOAD_VALIDATORS` and any bounds to `limits.ts`.
3. Add a case to `gadgetFallbackText` — a kind with no text form is not done.
4. Add a renderer under `renderer/src/ai/gadgets/renderers/` and register it in
   that folder's `index.ts`.
5. Add a fixture to `buildGadgetFixtures`. `fixtures.test.ts` asserts the
   catalogue covers every declared kind, so step 5 is not optional — it fails
   the moment step 1 lands without it.

## Diagnostics

- `window.praxis.gadgets.replay(0)` returns the ledger's event sequence
  (status, gadget, correlation) — the first thing to read when a user says an
  action "did nothing".
- Published blocks and the ledger live in `userData/gadgets.json`; the host
  identity that scopes them is in `userData/host-identity.json`.
- A renderer crash is contained by an error boundary, logged to the renderer
  console as `[gadget] renderer for "<kind>" threw`, and shown as text.

## Tests

```bash
npm run test:core -- # includes validation, lifecycle and fixture contract tests
npx playwright test e2e/chatGadgets.spec.ts --project=functional
```

The e2e suite drives the real producer path — the mock gateway returns a
message containing fences — so parsing, validation and scope stamping are
exercised rather than skipped by hand-building an envelope in the renderer.
