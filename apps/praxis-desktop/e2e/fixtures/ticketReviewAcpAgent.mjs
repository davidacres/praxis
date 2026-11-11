#!/usr/bin/env node
// A scripted ACP agent for the interactive ticket review. It is a real ACP
// subprocess over the real SDK wire, standing in for the model: what it says is
// fixed, but everything between it and the UI — the session, the gadget
// publish/validate pipeline, the answers travelling back as follow-up turns,
// the apply action reaching the tracker — is the production path.
//
// The script, keyed off the latest thing the user said (the newest marker wins,
// because a resumed turn's prompt can carry the earlier ones as history):
//   - a "Gadget response" (the host reporting a chosen option) -> the apply form
//   - the first turn ("Review ticket")                         -> a verdict + findings choice
//   - a free-text follow-up ("FOLLOW_UP_NOTE")                 -> a plain acknowledgement
//   - the host asking for an undisplayable gadget again        -> the valid findings choice
//
// TICKET_REVIEW_FIXTURE_MODE makes the first reply badly formatted, the way a
// real model sometimes is:
//   - "sloppy":   the fence glued to a sentence, an unescaped quote inside a
//                 string, and a description far over the 2000-character limit.
//                 All repairable — it must render with no second turn.
//   - "broken":   truncated JSON that cannot be repaired. The page must ask for
//                 the gadget again, and the retry is answered correctly.
//   - "stubborn": broken every time, to prove the retry is capped.
//   - "hang":     never answers the first turn until `session/cancel` arrives,
//                 to hold the review mid-turn for the composer's Cancel.

import { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const acp = await import(pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href);

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const app = acp.agent({ name: 'ticket-review-acp-agent' });

/** The text the apply form proposes; the spec asserts the ticket ends up with it (mirrored there). */
const UPDATED_DESCRIPTION = 'Reviewed description.\n\n- [ ] Acceptance criterion added by the review.';

const fence = gadget => `\`\`\`praxis-gadget\n${JSON.stringify(gadget)}\n\`\`\``;

const FINDINGS = fence({
  version: 1,
  kind: 'choice',
  gadgetId: 'review-findings',
  payload: {
    question: 'Which of these should go into the ticket?',
    multiple: true,
    options: [
      { value: 'f1', label: 'Add acceptance criterion: empty state', description: '- [ ] Acceptance criterion added by the review.' },
      { value: 'f2', label: 'Clarify scope: export formats', description: 'State which formats are in scope.' },
      { value: 'f3', label: 'Rewrite the summary', description: 'Make the summary describe the outcome.' }
    ]
  },
  actions: [{ actionId: 'apply-selected', label: 'Continue with selected', effect: 'informational' }]
});

const MODE = process.env.TICKET_REVIEW_FIXTURE_MODE ?? '';
const HEAD = '{"version":1,"kind":"choice","gadgetId":"review-findings","payload":{"question":"Which of these should go into the ticket?","multiple":true,"options":[{"value":"f1","label":"Restore missing sections","description":';
const TAIL = '}]},"actions":[{"actionId":"apply-selected","label":"Continue with selected","effect":"informational"}]}';
// Hand-assembled, not JSON.stringify: the point is that it is *not* valid JSON.
const SLOPPY = `Here is the one actionable finding.\`\`\`praxis-gadget\n${HEAD}"Access: a "System One LLM wrapper" for Python. ${'x'.repeat(3500)}"${TAIL}\n\`\`\``;
const BROKEN = `Here is the one actionable finding.\n\n\`\`\`praxis-gadget\n${HEAD}"A description that never closes\n\`\`\``;

const applyForm = note => fence({
  version: 1,
  kind: 'form',
  gadgetId: 'review-apply',
  payload: {
    title: 'Review the ticket update',
    description: note,
    fields: [
      { name: 'description', label: 'Description', type: 'textarea', required: true, defaultValue: UPDATED_DESCRIPTION },
      { name: 'comment', label: 'Comment', type: 'textarea', defaultValue: 'Posted by the review.' }
    ]
  },
  actions: [
    { actionId: 'apply', label: 'Apply to ticket', effect: 'mutating', gate: 'ticket-review:apply' },
    { actionId: 'discard', label: 'Not now', effect: 'informational' }
  ]
});

app.onRequest(acp.AGENT_METHODS.initialize, () => ({
  protocolVersion: acp.PROTOCOL_VERSION,
  agentCapabilities: { promptCapabilities: { image: true } }
}));
app.onRequest(acp.AGENT_METHODS.session_new, () => ({ sessionId: 'ticket-review-session-1' }));
let resolveCancel;
const cancelled = new Promise(resolve => {
  resolveCancel = resolve;
});
app.onNotification(acp.AGENT_METHODS.session_cancel, () => resolveCancel());

app.onRequest(acp.AGENT_METHODS.session_prompt, async ctx => {
  const promptText = ctx.params.prompt.map(block => (block.type === 'text' ? block.text : '')).join('');

  // Whichever marker appears *last* is the user's newest message: a resumed
  // turn can carry earlier ones as history. (The system prompt also mentions
  // "Gadget response", so the marker includes the dash and quote the host's own
  // follow-up always has.)
  const markers = [
    ['answered', promptText.lastIndexOf('Gadget response — "')],
    ['followup', promptText.lastIndexOf('FOLLOW_UP_NOTE')],
    ['review', promptText.lastIndexOf('Review ticket')],
    ['retry', promptText.lastIndexOf('could not be displayed')]
  ];
  const [newest] = markers.reduce((best, entry) => (entry[1] > best[1] ? entry : best), ['none', -1]);

  if (MODE === 'hang') {
    await cancelled;
    return { stopReason: 'cancelled' };
  }

  if (MODE === 'permission' && newest === 'review') {
    const response = await ctx.client.request(acp.CLIENT_METHODS.session_request_permission, {
      sessionId: ctx.params.sessionId,
      toolCall: { toolCallId: 'review-read', title: 'Read ticket context', name: 'read_file', kind: 'read' },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' }
      ]
    });
    if (response.outcome.outcome !== 'selected' || response.outcome.optionId !== 'allow') {
      return { stopReason: 'cancelled' };
    }
  }

  // Hold only the initial review so a queued follow-up can finish normally.
  if (MODE === 'slow' && newest === 'review') await new Promise(resolve => setTimeout(resolve, 4000));

  // What the review's first reply looks like: valid, or badly formatted per MODE.
  const firstReply = () => {
    if (MODE === 'sloppy') return SLOPPY;
    if (MODE === 'broken' || MODE === 'stubborn') return BROKEN;
    // Deliberately says "rate limits": that vocabulary once made the host discard a
    // good review as a provider failure. Every review spec now runs through it.
    return `**Verdict: Needs work.** The ticket is missing an empty state and says nothing about rate limits or quota.\n\n${FINDINGS}`;
  };

  let reply;
  if (newest === 'answered') {
    reply = `Here is the updated ticket. Nothing is written until you apply it.\n\n${applyForm('Edit anything before applying.')}`;
  } else if (newest === 'retry') {
    // Asked to send the gadget again: fix it, unless this agent never learns.
    reply = MODE === 'stubborn' ? BROKEN : `Sorry — here it is again.\n\n${FINDINGS}`;
  } else if (newest === 'review') {
    reply = firstReply();
  } else {
    const imageCount = ctx.params.prompt.filter(block => block.type === 'image').length;
    reply = `Understood — ask again if you want another change. Images received: ${imageCount}.`;
  }

  await ctx.client.notify(acp.CLIENT_METHODS.session_update, {
    sessionId: ctx.params.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } }
  });
  return { stopReason: 'end_turn' };
});

const connection = app.connect(stream);
await connection.closed;
