# FX-BE-036 — Prove multi-file and terminal-using agent paths

**Type:** Story  **Status:** Planned  **Priority:** P2  **Depends on:** FX-BE-031

## Business or operational impact
The ticket-to-agent flow is proven, in the always-on scripted suite, only for single-file, no-shell edits. Multi-file and terminal use are plumbed but unproven the same way.

## Scope
- A scripted, no-model-call fixture editing ≥2 files in one turn.
- A scripted fixture running a shell command through the agent, with a verified real side effect.
- Both in the normal suite, not gated behind the live-agent opt-in.

## Acceptance criteria
- Multi-file: all edits verified on disk, each its own diff in the transcript.
- Shell: stdout in the transcript, a real side effect verified on disk.
- Both run on every push with no model call.

## Validation
- `npm run check-types`
- `npm run test:desktop`

## Close when
"It can take a ticket and do the work" holds for multi-file and terminal-using tickets with the same scripted proof the single-file case already has.
