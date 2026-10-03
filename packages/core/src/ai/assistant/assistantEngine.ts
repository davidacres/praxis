import { DEFAULT_ASSISTANT_ROLE, getAssistantPersona, parseAssistantMention, TEAM_REVIEW_ORDER } from './assistantPersonas';
import type {
  AssistantChoiceOption,
  AssistantMessage,
  AssistantProposedAction,
  AssistantRole,
  AssistantTeamReviewRequest,
  AssistantTurnRequest,
  AssistantTurnResult,
  PageAssistantContext
} from './assistantTypes';

/** One model call: the engine is provider-agnostic, main wires this to the runtime. */
export type AssistantCompletion = (input: { systemPrompt: string; userPrompt: string; allowMutations: boolean }) => Promise<string>;

export const MAX_CONTEXT_CHARS = 12_000;
export const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 3_000;
export const MAX_ASSISTANT_MESSAGE_CHARS = 4_000;

const PROTOCOL_PROMPT = `Optional structured footer: after your answer you MAY add ONE fenced block tagged praxis-assistant containing JSON:
{"choices":[{"label":"short button text","prompt":"what the user would say next"}],"action":{...}}
- "choices": at most 3 follow-up options, only when the user has a real decision to make.
- "action" (optional, only when the user clearly asked for it): one of
  {"kind":"update-ticket","label":"Apply to ticket","summary":"...","description":"full replacement description"}
  {"kind":"create-subtask","label":"Create subtask","summary":"...","title":"short task title","description":"task description"} (only on an issue page)
  {"kind":"delegate-session","label":"Open as Coding Session","summary":"...","prompt":"task prompt for an autonomous coding agent"}
  {"kind":"update-workflow","label":"Apply workflow changes","summary":"...","workflow":{complete workflow definition}} (only on the workflow page)
Omit the block entirely when you have nothing to offer.`;

/** Wraps page state in a clearly-marked, size-bounded block. */
export function serializePageContext(context: PageAssistantContext, maxChars = MAX_CONTEXT_CHARS): string {
  const data = context.data ?? '';
  const clipped = data.length > maxChars ? `${data.slice(0, maxChars)}\n…[truncated ${data.length - maxChars} characters]` : data;
  return [`[Current Page Context: ${context.title}]`, context.summary, clipped, '[End Page Context]'].filter(Boolean).join('\n');
}

function serializeHistory(history: readonly AssistantMessage[] | undefined): string {
  const recent = (history ?? []).filter(entry => !entry.error).slice(-MAX_HISTORY_MESSAGES);
  if (recent.length === 0) return '';
  const lines = recent.map(entry => {
    const speaker = entry.role === 'user' ? 'User' : getAssistantPersona(entry.role).name;
    return `${speaker}: ${entry.text.slice(0, MAX_HISTORY_CHARS)}`;
  });
  return `Conversation so far:\n${lines.join('\n')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAction(raw: unknown): AssistantProposedAction | undefined {
  if (!isRecord(raw) || typeof raw.label !== 'string' || typeof raw.summary !== 'string') return undefined;
  const base = { label: raw.label.slice(0, 80), summary: raw.summary.slice(0, 600) };
  if (raw.kind === 'update-ticket' && typeof raw.description === 'string') return { kind: 'update-ticket', ...base, description: raw.description };
  if (raw.kind === 'create-subtask' && typeof raw.title === 'string' && raw.title.trim() && typeof raw.description === 'string') {
    return { kind: 'create-subtask', ...base, title: raw.title.trim().slice(0, 200), description: raw.description };
  }
  if (raw.kind === 'delegate-session' && typeof raw.prompt === 'string') return { kind: 'delegate-session', ...base, prompt: raw.prompt };
  if (raw.kind === 'update-workflow' && isRecord(raw.workflow)) return { kind: 'update-workflow', ...base, workflow: raw.workflow };
  return undefined;
}

/**
 * Splits a model reply into prose and its optional `praxis-assistant` footer.
 * A malformed footer is dropped silently — the prose is still the answer.
 */
export function parseAssistantReply(raw: string): { text: string; choices?: AssistantChoiceOption[]; proposedAction?: AssistantProposedAction } {
  const match = /```praxis-assistant\s*([\s\S]*?)```/i.exec(raw);
  const text = (match ? raw.replace(match[0], '') : raw).trim();
  if (!match) return { text };
  try {
    const parsed: unknown = JSON.parse(match[1]);
    if (!isRecord(parsed)) return { text };
    const choices = Array.isArray(parsed.choices)
      ? parsed.choices
          .filter((choice): choice is { label: string; prompt: string } => isRecord(choice) && typeof choice.label === 'string' && typeof choice.prompt === 'string')
          .slice(0, 3)
          .map(choice => ({ label: choice.label.slice(0, 60), prompt: choice.prompt.slice(0, 400) }))
      : [];
    const proposedAction = parseAction(parsed.action);
    return { text, ...(choices.length ? { choices } : {}), ...(proposedAction ? { proposedAction } : {}) };
  } catch {
    return { text };
  }
}

let counter = 0;
function messageId(): string {
  counter += 1;
  return `msg-${Date.now().toString(36)}-${counter}`;
}

function actionAllowedOn(action: AssistantProposedAction, context: PageAssistantContext | undefined): boolean {
  if (action.kind === 'update-workflow') return context?.pageType === 'workflow';
  if (action.kind === 'update-ticket' || action.kind === 'create-subtask') return context?.pageType === 'issue';
  return true;
}

function buildMessage(role: AssistantRole, raw: string, context: PageAssistantContext | undefined): AssistantMessage {
  const parsed = parseAssistantReply(raw);
  return {
    id: messageId(),
    role,
    text: parsed.text || '(no response)',
    createdAt: new Date().toISOString(),
    ...(context ? { contextTitle: context.title } : {}),
    ...(parsed.choices ? { choices: parsed.choices } : {}),
    // Only the page that can apply a change may be offered it; elsewhere the proposal is dropped.
    ...(parsed.proposedAction && actionAllowedOn(parsed.proposedAction, context)
      ? { proposedAction: parsed.proposedAction }
      : {})
  };
}

function errorMessage(role: AssistantRole, error: unknown): AssistantMessage {
  const detail = error instanceof Error ? error.message : String(error);
  return { id: messageId(), role, text: `I couldn't answer: ${detail}`, createdAt: new Date().toISOString(), error: true };
}

function assertMessage(message: string): string {
  const text = message.trim();
  if (!text) throw new Error('Ask the team something first.');
  if (text.length > MAX_ASSISTANT_MESSAGE_CHARS) throw new Error(`Messages must be ${MAX_ASSISTANT_MESSAGE_CHARS.toLocaleString('en-US')} characters or fewer.`);
  return text;
}

function userPrompt(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join('\n\n');
}

/** A single persona answers the user's message. `@mention` wins over the default seat. */
export async function runAssistantTurn(request: AssistantTurnRequest, complete: AssistantCompletion): Promise<AssistantTurnResult> {
  const text = assertMessage(request.message);
  const personaId = parseAssistantMention(text).personaId ?? request.personaId ?? DEFAULT_ASSISTANT_ROLE;
  const persona = getAssistantPersona(personaId);
  try {
    const raw = await complete({
      systemPrompt: `${persona.systemPrompt}\n\n${PROTOCOL_PROMPT}`,
      userPrompt: userPrompt([
        request.context ? serializePageContext(request.context) : undefined,
        serializeHistory(request.history),
        `Current user message:\n${text}`
      ]),
      allowMutations: request.context?.pageType === 'workflow'
    });
    return { messages: [buildMessage(persona.id, raw, request.context)] };
  } catch (error) {
    return { messages: [errorMessage(persona.id, error)] };
  }
}

/** Dev → QA → Security → Lead, each seeing the earlier replies. Stops at the first failure. */
export async function runTeamReview(request: AssistantTeamReviewRequest, complete: AssistantCompletion): Promise<AssistantTurnResult> {
  const prompt = request.prompt?.trim() || 'Review what is on this page from your seat.';
  if (prompt.length > MAX_ASSISTANT_MESSAGE_CHARS) throw new Error(`Messages must be ${MAX_ASSISTANT_MESSAGE_CHARS.toLocaleString('en-US')} characters or fewer.`);
  const produced: AssistantMessage[] = [];
  for (const role of TEAM_REVIEW_ORDER) {
    const persona = getAssistantPersona(role);
    const earlier = produced.map(entry => `${getAssistantPersona(entry.role as AssistantRole).name}: ${entry.text}`).join('\n\n');
    try {
      const raw = await complete({
        systemPrompt: `${persona.systemPrompt}\n\n${PROTOCOL_PROMPT}`,
        userPrompt: userPrompt([
          request.context ? serializePageContext(request.context) : undefined,
          serializeHistory(request.history),
          earlier ? `Team members who already spoke:\n${earlier}` : undefined,
          role === 'lead'
            ? `Team review request: ${prompt}\nSynthesise the team's input into a concise verdict and ordered next steps.`
            : `Team review request: ${prompt}\nGive your review from your seat only, in under 150 words.`
        ]),
        allowMutations: false
      });
      produced.push(buildMessage(role, raw, request.context));
    } catch (error) {
      produced.push(errorMessage(role, error));
      break;
    }
  }
  return { messages: produced };
}

/** A sidebar title taken from the first user message. */
export function deriveChatTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return 'New team chat';
  return flat.length > 48 ? `${flat.slice(0, 47).trimEnd()}…` : flat;
}
