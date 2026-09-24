/**
 * Host-side helpers for a client that shows gadgets but does not own the
 * conversation's publishing — the phone. The desktop renderer keeps its own
 * copies (`renderer/src/ai/gadgets/messageText.ts`, `useSessionGadgets.ts`)
 * because it may import only types from core; these must stay in step with them.
 */
import type { AnyGadgetEnvelope, FormGadgetPayload, GadgetActionValue } from './contracts';
import { GADGET_FENCE_LANGUAGE } from './blockParser';

const FENCE = /[ \t]*```[ \t]*praxis-gadget[ \t]*\r?\n[\s\S]*?```[ \t]*$/gm;

/** A message's text with its gadget fences removed — the gadgets are drawn separately. */
export function stripGadgetFences(text: string): string {
  if (!text.includes(GADGET_FENCE_LANGUAGE)) return text;
  FENCE.lastIndex = 0;
  return text.replace(FENCE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The key a message's gadgets are published under: its index among the
 * session's conversation events, exactly as the desktop's Sessions page counts
 * them. Using the same key means the phone and the desktop answer the *same*
 * gadget, not two copies of it.
 */
export function gadgetMessageKey(conversationIndex: number): string {
  return `msg-${conversationIndex}`;
}

/** Whether an event is one the desktop's conversation view counts (and so indexes gadgets by). */
export function isConversationEvent(event: { type: string; detail?: string; summary?: string }): boolean {
  return (event.type === 'message' || event.type === 'user_input_completed') && Boolean(event.detail || event.summary);
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
 * The follow-up message that reports an answer to the agent, or undefined when
 * the answer is not an open decision the agent is waiting on (a confirmation,
 * an approval, or a form with a gated action already reaches its own service).
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
    const answer = describeFormAnswer(envelope.payload, value.fields);
    return answer ? `Gadget response — "${envelope.payload.title}": ${answer}.` : undefined;
  }
  if (envelope.kind !== 'choice') return undefined;

  switch (value.kind) {
    case 'choice': {
      const option = envelope.payload.options.find(candidate => candidate.value === value.selected);
      return `Gadget response — "${envelope.payload.question}": ${option?.label ?? value.selected}.`;
    }
    case 'selection': {
      const labels = value.selected.map(
        selected => envelope.payload.options.find(candidate => candidate.value === selected)?.label ?? selected
      );
      return `Gadget response — "${envelope.payload.question}": ${labels.join(', ')}.`;
    }
    default:
      return undefined;
  }
}
