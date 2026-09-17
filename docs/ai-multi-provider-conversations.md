# Multi-provider AI conversations

Praxis can run a bounded conversation between two AI providers inside one session.
The original session runtime is the **host** and the invited runtime is the
**guest**. Each assistant turn is persisted with its participant id, provider,
model, and icon, so the chat remains attributable after the session is reopened.

## Modes

- **Consult** — both participants are read-only. Use this for independent review,
  critique, planning, or risk identification.
- **Debate** — both participants are read-only and alternate perspectives.
- **Pair** — one participant owns tools at a time. The `Tools:` chip shows the
  owner and the ownership chip transfers tools only between turns.

The conversation is sequential, not simultaneous. Praxis alternates participants
until the configured turn cap, or until the user stops it. Tool access is enforced
by the host in addition to the prompt, so a read-only participant cannot edit files,
run commands, or mutate external systems.

## Directing a human message

While a conversation is running, the composer shows an **Ask** chip with the two
participant identities. Select either participant, type in the composer, and use
the arrow button. If the other AI is still working, Praxis queues the message and
delivers it to the selected participant at the next turn boundary. The message is
recorded once in the transcript and the normal alternating schedule then resumes.

The stop button remains separate from the directed-send button. Stopping a
conversation ends the bounded exchange and restores the original single-agent
runtime and tool mode.

## What belongs in the chat

Assistant bubbles show the provider icon, provider name, model, and a participant
accent (host or guest). Ordinary explanatory text remains Markdown. Structured
decisions should use the existing choice/confirmation gadgets; multi-AI mode is
for review and collaboration, not for turning every recommendation into a control.
