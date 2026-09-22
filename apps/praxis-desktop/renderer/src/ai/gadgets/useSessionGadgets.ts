import { useEffect, useRef, useState } from 'react';
import type {
  AgentEventSummary,
  AgentSessionRecord,
  AnyGadgetEnvelope,
  ChatBlock,
  FormGadgetPayload,
  GadgetActionResult,
  GadgetActionValue
} from '@praxis/core';
import { isTerminalAgentState } from '../aiSessionState';
import { gadgetMessageKey, groupBlocksByMessage, mayContainGadget } from './messageText';

/** Every published gadget block for a session, searched by `gadgetId` — blocks are keyed by message, not by gadget. */
function findGadgetEnvelope(blocks: Record<string, ChatBlock[]>, gadgetId: string): AnyGadgetEnvelope | undefined {
  for (const list of Object.values(blocks)) {
    for (const block of list) {
      if (block.type === 'gadget' && block.gadget.gadgetId === gadgetId) return block.gadget;
    }
  }
  return undefined;
}

function describeFormAnswer(payload: FormGadgetPayload, fields: Record<string, string | number | boolean>): string {
  return payload.fields
    .filter(field => fields[field.name] !== undefined && fields[field.name] !== '')
    .map(field => {
      const raw = fields[field.name];
      const shown = field.options?.find(option => option.value === raw)?.label ?? String(raw);
      return `${field.label}: ${shown}`;
    })
    .join('; ');
}

/**
 * Turns a recorded answer into the follow-up message that reports it to the
 * agent — the same shape a person would have typed.
 *
 * Scoped to a genuine open decision: a `choice`, or a `form` whose every action
 * is informational. A `confirmation`, or a form that pairs with a `mutating` /
 * `approval` action (the ticket-review apply form), already reaches a real
 * service through its own gated executor — piling an automatic follow-up turn
 * onto those would risk a second, uncoordinated way of telling the agent
 * something happened. Only fires for an `informational` action.
 */
export function describeGadgetAnswer(
  envelope: AnyGadgetEnvelope | undefined,
  actionId: string,
  value: GadgetActionValue
): string | undefined {
  if (!envelope) return undefined;
  const action = envelope.actions.find(candidate => candidate.actionId === actionId);
  if (action && action.effect !== 'informational') return undefined;

  if (envelope.kind === 'form') {
    if (value.kind !== 'form' || envelope.actions.some(candidate => candidate.effect !== 'informational')) return undefined;
    const answer = describeFormAnswer(envelope.payload as FormGadgetPayload, value.fields);
    return answer ? `Gadget response — "${(envelope.payload as FormGadgetPayload).title}": ${answer}.` : undefined;
  }
  if (envelope.kind !== 'choice') return undefined;

  switch (value.kind) {
    case 'choice': {
      const option = envelope.payload.options.find(candidate => candidate.value === value.selected);
      return `Gadget response — "${envelope.payload.question}": ${option?.label ?? value.selected}.`;
    }
    case 'selection': {
      const labels = value.selected.map(
        selectedValue => envelope.payload.options.find(candidate => candidate.value === selectedValue)?.label ?? selectedValue
      );
      return `Gadget response — "${envelope.payload.question}": ${labels.join(', ')}.`;
    }
    default:
      return undefined;
  }
}

export interface SessionGadgetOptions {
  /**
   * When the agent's latest message asked for a gadget that could not be shown
   * (invalid JSON the parser could not repair, or a schema refusal), send it one
   * follow-up asking for that gadget again, up to twice per session. For a
   * conversation whose whole point is the decision — a review — a raw JSON blob
   * in the transcript is a dead end, and the agent can fix its own output.
   */
  retryUnrenderedGadgets?: boolean;
}

/** Enough to correct a typo'd block; more would be a model that cannot format it. */
const MAX_GADGET_RETRIES = 2;

/** How many times an undelivered retry request is re-sent before giving up on it. */
const MAX_SEND_FAILURES = 5;

const RETRY_REQUEST = (reason: string | undefined) =>
  `Your last praxis-gadget block could not be displayed${reason ? ` (${reason})` : ''}. ` +
  'Send only that decision again as one fenced praxis-gadget block, with the opening fence on its own line, as valid JSON: ' +
  'escape every double quote inside a string as \\" (or avoid quotes), and keep each option description to a short summary ' +
  '(under 300 characters) — never paste long text into it. Do not repeat the rest of the review.';

/**
 * The gadget half of a session's conversation: publishes whatever the agent's
 * messages asked for, keeps the resolved blocks current, and submits the
 * user's answers — reporting a decision back to the agent so it reaches the
 * next turn instead of sitting in the ledger.
 *
 * Shared by the Sessions console and the ticket-review page, which are the same
 * conversation seen through two surfaces.
 */
export function useSessionGadgets(
  session: AgentSessionRecord | undefined,
  conversationEvents: AgentEventSummary[],
  options: SessionGadgetOptions = {}
) {
  const sessionId = session?.sessionId;
  // Blocks are keyed by the message that asked for them, so a response renders
  // its own surfaces inline rather than pooling them all at the bottom.
  const [gadgetBlocks, setGadgetBlocks] = useState<Record<string, ChatBlock[]>>({});
  const [gadgetResults, setGadgetResults] = useState<Record<string, GadgetActionResult>>({});
  const [busyGadgetId, setBusyGadgetId] = useState<string>();
  // How many conversation events the host has finished publishing gadgets for.
  const [publishedLength, setPublishedLength] = useState(-1);

  /**
   * Publishing is idempotent — the same message mints the same gadget IDs, and
   * the host replaces in place — so re-running this on every new event is safe
   * and is what lets a streaming progress gadget update rather than stack up.
   */
  useEffect(() => {
    if (!sessionId) {
      setGadgetBlocks({});
      return;
    }
    let cancelled = false;
    const eventCount = conversationEvents.length;

    const refresh = async () => {
      const blocks = await window.praxis.gadgets.getBlocks(sessionId);
      if (!cancelled) setGadgetBlocks(groupBlocksByMessage(blocks));
    };

    void (async () => {
      for (const [index, event] of conversationEvents.entries()) {
        if (event.type !== 'message' || !mayContainGadget(event.detail)) continue;
        await window.praxis.gadgets.publishFromText(sessionId, gadgetMessageKey(index), event.detail ?? '');
        if (cancelled) return;
      }
      await refresh();
      // Set after the blocks, so "published through N" never outruns the blocks it vouches for.
      if (!cancelled) setPublishedLength(eventCount);
    })();

    // The host broadcasts after every publish and every submission, so an
    // action answered elsewhere (or a gadget the host revoked) lands here too.
    const unsubscribe = window.praxis.gadgets.onChanged(changedSessionId => {
      if (changedSessionId === sessionId) void refresh();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // `conversationEvents` is rebuilt every render; its length is what actually
    // changes when the agent says something new.
  }, [sessionId, conversationEvents.length]);

  // Results belong to one session's gadgets; carrying them over would show
  // "Applied" on a fresh review whose gadget happens to reuse an id.
  useEffect(() => {
    setGadgetResults({});
    setPublishedLength(-1);
  }, [sessionId]);

  const retryCounts = useRef(new Map<string, number>());
  const retriedMessages = useRef(new Set<string>());
  const sendFailures = useRef(new Map<string, number>());
  // Bumped to re-run the retry effect after a send that the host was not ready for.
  const [retryTick, setRetryTick] = useState(0);
  useEffect(() => {
    if (!options.retryUnrenderedGadgets || !session || !sessionId) return;
    if (session.state === 'failed' || !isTerminalAgentState(session.state)) return;
    // Only once the host has published this many events' worth of blocks.
    if (publishedLength !== conversationEvents.length) return;
    const index = conversationEvents.length - 1;
    const latest = conversationEvents[index];
    // Only the newest thing in the thread, and only an assistant message: an
    // older message the user has already moved past is not worth a turn.
    if (!latest || latest.type !== 'message' || !mayContainGadget(latest.detail)) return;
    const key = gadgetMessageKey(index);
    const blocks = gadgetBlocks[key] ?? [];
    if (blocks.some(block => block.type === 'gadget')) return;

    const messageId = `${sessionId}:${key}`;
    if (retriedMessages.current.has(messageId)) return;
    if ((retryCounts.current.get(sessionId) ?? 0) >= MAX_GADGET_RETRIES) return;
    retriedMessages.current.add(messageId);
    retryCounts.current.set(sessionId, (retryCounts.current.get(sessionId) ?? 0) + 1);

    const refusal = blocks.find(block => block.type === 'fallback');
    const reason = refusal && refusal.type === 'fallback' ? refusal.reason?.message : undefined;
    void window.praxis.ai.continueSession(session.issueKey, RETRY_REQUEST(reason)).catch(() => {
      // The record reads `completed` a beat before the host frees the task, so the
      // usual failure is "still working". The request was not delivered, so it
      // must not count as one of the retries: release it and try again shortly.
      retriedMessages.current.delete(messageId);
      retryCounts.current.set(sessionId, Math.max(0, (retryCounts.current.get(sessionId) ?? 1) - 1));
      const failures = (sendFailures.current.get(messageId) ?? 0) + 1;
      sendFailures.current.set(messageId, failures);
      if (failures <= MAX_SEND_FAILURES) setTimeout(() => setRetryTick(tick => tick + 1), 400 * failures);
    });
  }, [options.retryUnrenderedGadgets, session?.state, session?.issueKey, sessionId, publishedLength, conversationEvents.length, gadgetBlocks, retryTick]);

  const submitGadgetAction = async (gadgetId: string, actionId: string, value: GadgetActionValue) => {
    if (!sessionId) return;
    setBusyGadgetId(gadgetId);
    try {
      const result = await window.praxis.gadgets.submit({
        sessionId,
        gadgetId,
        actionId,
        value,
        // Deterministic, so a double submission of the same decision replays
        // the recorded outcome instead of applying it twice. A refused
        // submission never consumes the key, so a corrected retry still works.
        idempotencyKey: `${sessionId}:${gadgetId}:${actionId}`,
        correlationId: `${sessionId}:${gadgetId}`
      });
      setGadgetResults(current => ({ ...current, [gadgetId]: result }));

      // An `informational` action only records a decision — the ledger and the
      // UI both know it happened, but the agent that asked never does, because
      // nothing here is on the conversation path. Reporting the answer back as
      // a follow-up turn (the same path `sendFollowUp` uses) is what closes the
      // loop. Only fires for a genuinely recorded answer (not `rejected` /
      // `failed`), only once per submission (a replay of an already-answered
      // gadget must not re-send the same follow-up), and only while the session
      // can accept one.
      if (
        (result.status === 'completed' || result.status === 'accepted') &&
        !result.replay &&
        session &&
        isTerminalAgentState(session.state)
      ) {
        const summary = describeGadgetAnswer(findGadgetEnvelope(gadgetBlocks, gadgetId), actionId, value);
        if (summary) {
          await window.praxis.ai.continueSession(session.issueKey, summary);
        }
      }
    } finally {
      setBusyGadgetId(undefined);
    }
  };

  return { gadgetBlocks, gadgetResults, busyGadgetId, submitGadgetAction };
}
