/**
 * Turn a provider's message into chat blocks (TASK-286).
 *
 * Provider-neutral by construction: this reads *text*, so Claude, Codex,
 * Copilot and any workflow stage all reach gadgets the same way, with no
 * adapter-specific contract and no dependency on private transcript access. A
 * provider asks for a gadget by emitting a fenced block:
 *
 * ```praxis-gadget
 * { "kind": "choice", "payload": { … }, "actions": [ … ] }
 * ```
 *
 * The producer supplies only *what to ask*. Identity, scope and issue time are
 * stamped by the host here — a model that could name its own scope could aim an
 * approval at another project, so those fields are overwritten, never merged.
 */
import { GADGET_CONTRACT_VERSION, GADGET_KINDS, type GadgetScope } from './contracts';
import type { RawChatBlockInput } from './gadgetService';
import { parseLenientJson } from './jsonRepair';

export const GADGET_FENCE_LANGUAGE = 'praxis-gadget';

/** Cheap pre-check so a caller can skip parsing text that cannot contain one. */
export function mayContainGadget(text: string): boolean {
  return text.includes(GADGET_FENCE_LANGUAGE) || text.includes('"kind"');
}

/**
 * A gadget fence. Models are loose about where it goes, so the opening fence may
 * follow prose on the same line ("…from the review.```praxis-gadget") and the
 * closing one may follow the JSON directly. The closing fence must end its line,
 * which is what keeps a "```" *inside* a JSON string (always mid-line, as the
 * JSON is one line) from ending the block early.
 */
const FENCE_OPEN = /```[ \t]*praxis-gadget[ \t]*\r?\n/g;
const LINE_END = /^[\n\r\u2028\u2029]/;

export interface GadgetFence {
  /** Index of the opening ```. */
  index: number;
  /** Index just past the closing fence (and trailing blanks), before the line break. */
  end: number;
  /** Index where the body starts (just after the opening line's newline). */
  bodyStart: number;
  body: string;
}

/**
 * If a closing fence (``` followed only by blanks to the end of its line) starts
 * at or after `from`, the index just past it, else -1. Scans once, left to right.
 */
function findClosingFence(text: string, from: number): { start: number; end: number } | undefined {
  for (let i = text.indexOf('```', from); i !== -1; i = text.indexOf('```', i + 1)) {
    let end = i + 3;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1;
    if (end === text.length || LINE_END.test(text[end])) return { start: i, end };
  }
  return undefined;
}

/** Start index of the last closing fence in `text` (any ``` that ends its line), or -1. */
export function lastClosingFenceIndex(text: string): number {
  for (let i = text.lastIndexOf('```'); i !== -1; i = i === 0 ? -1 : text.lastIndexOf('```', i - 1)) {
    let end = i + 3;
    while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1;
    if (end === text.length || LINE_END.test(text[end])) return i;
  }
  return -1;
}

/**
 * Every closed gadget fence, in order — a linear scanner standing in for
 * `/```[ \t]*praxis-gadget[ \t]*\r?\n([\s\S]*?)```[ \t]*$/gm`, whose lazy body
 * rescanned the rest of the text from every unclosed opening. Once an opening
 * has no closing fence after it, no later opening can have one either.
 */
export function findGadgetFences(text: string): GadgetFence[] {
  const fences: GadgetFence[] = [];
  let pos = 0;
  for (;;) {
    FENCE_OPEN.lastIndex = pos;
    const open = FENCE_OPEN.exec(text);
    if (!open) break;
    const bodyStart = open.index + open[0].length;
    const close = findClosingFence(text, bodyStart);
    if (!close) break;
    fences.push({ index: open.index, end: close.end, bodyStart, body: text.slice(bodyStart, close.start) });
    pos = close.end;
  }
  return fences;
}

/** Index of every opening gadget fence in `text`, in order. */
export function gadgetFenceOpenings(text: string): Array<{ index: number; bodyStart: number }> {
  const out: Array<{ index: number; bodyStart: number }> = [];
  const open = new RegExp(FENCE_OPEN.source, 'g');
  for (let m = open.exec(text); m !== null; m = open.exec(text)) out.push({ index: m.index, bodyStart: m.index + m[0].length });
  return out;
}

export interface ChatBlockParseOptions {
  /** Stamped onto every gadget; never taken from the producer. */
  scope: GadgetScope;
  issuedAt: string;
  /** Prefix for minted gadget IDs. Stable input must give stable IDs. */
  idPrefix: string;
}

export interface ParsedChatBlocks {
  blocks: RawChatBlockInput[];
  /** True when at least one gadget fence was found (valid or not). */
  containsGadget: boolean;
  /** Fences whose body was not valid JSON. They survive as visible code. */
  malformed: number;
}

function pushMarkdown(blocks: RawChatBlockInput[], text: string, blockId?: string): void {
  const trimmed = text.trim();
  if (trimmed) blocks.push({ type: 'markdown', markdown: trimmed, ...(blockId ? { blockId } : {}) });
}

/**
 * Longest text a choice option or question may carry — the limits
 * `validateGadgetEnvelope` enforces. The text is display-only (an answer sends the
 * option's `value`, and the agent still has its own full text in the
 * conversation), so a model that wrote too much gets a shortened option rather
 * than a refused decision.
 */
const CHOICE_TEXT_LIMITS = { question: 2_000, label: 400, description: 2_000, disabledReason: 400 } as const;

function clampText(value: unknown, max: number): unknown {
  if (typeof value !== 'string' || value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}

function clampChoiceText(gadget: unknown): unknown {
  if (!gadget || typeof gadget !== 'object' || Array.isArray(gadget)) return gadget;
  const envelope = gadget as { kind?: unknown; payload?: unknown };
  if (envelope.kind !== 'choice' || !envelope.payload || typeof envelope.payload !== 'object') return gadget;
  const payload = envelope.payload as { question?: unknown; options?: unknown };
  return {
    ...envelope,
    payload: {
      ...payload,
      question: clampText(payload.question, CHOICE_TEXT_LIMITS.question),
      ...(Array.isArray(payload.options)
        ? {
            options: payload.options.map(option =>
              option && typeof option === 'object'
                ? {
                    ...option,
                    label: clampText((option as { label?: unknown }).label, CHOICE_TEXT_LIMITS.label),
                    description: clampText((option as { description?: unknown }).description, CHOICE_TEXT_LIMITS.description),
                    disabledReason: clampText((option as { disabledReason?: unknown }).disabledReason, CHOICE_TEXT_LIMITS.disabledReason)
                  }
                : option
            )
          }
        : {})
    }
  };
}

function isGadgetShaped(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { kind, payload } = value as { kind?: unknown; payload?: unknown };
  return (
    typeof kind === 'string' &&
    (GADGET_KINDS as readonly string[]).includes(kind) &&
    !!payload &&
    typeof payload === 'object' &&
    !Array.isArray(payload)
  );
}

/**
 * Models sometimes write a gadget's JSON bare on its own line, with no fence. A
 * line that is a whole gadget-shaped object is wrapped in a fence so it takes the
 * same path as a fenced one. Lines inside any other code fence are left alone, so
 * a JSON sample shown as code is never turned into a gadget.
 */
function fenceBareGadgetLines(text: string): string {
  let inCodeFence = false;
  return text
    .split('\n')
    .map(line => {
      if (line.includes('```')) {
        inCodeFence = !inCodeFence;
        return line;
      }
      if (inCodeFence) return line;
      const trimmed = line.trim();
      if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return line;
      const lenient = parseLenientJson(trimmed);
      if (!lenient.ok || !isGadgetShaped(lenient.value)) return line;
      return `\`\`\`${GADGET_FENCE_LANGUAGE}\n${trimmed}\n\`\`\``;
    })
    .join('\n');
}

/**
 * Split `text` into ordered markdown and gadget blocks.
 *
 * A fence whose body is not JSON is preserved as a fenced code block rather
 * than dropped: the user sees exactly what the model produced, which is the
 * most debuggable outcome, and nothing silently disappears from a transcript.
 */
export function parseChatBlocks(raw: string, options: ChatBlockParseOptions): ParsedChatBlocks {
  const text = fenceBareGadgetLines(raw);
  const blocks: RawChatBlockInput[] = [];
  let lastIndex = 0;
  let found = 0;
  let malformed = 0;
  let mdIndex = 0;

  for (const match of findGadgetFences(text)) {
    pushMarkdown(blocks, text.slice(lastIndex, match.index), `${options.idPrefix}-md-${mdIndex++}`);
    lastIndex = match.end;
    found += 1;

    const lenient = parseLenientJson(match.body);
    if (!lenient.ok) {
      malformed += 1;
      pushMarkdown(blocks, `\`\`\`json\n${match.body.trim()}\n\`\`\``, `${options.idPrefix}-md-${mdIndex++}`);
      continue;
    }
    const parsed = clampChoiceText(lenient.value);

    const supplied = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
    const suppliedId = typeof supplied.gadgetId === 'string' && supplied.gadgetId.trim() ? supplied.gadgetId.trim() : undefined;
    blocks.push({
      type: 'gadget',
      // The block ID follows the gadget ID so re-parsing the same message
      // republishes over the same block instead of appending a duplicate.
      blockId: `${options.idPrefix}-${suppliedId ?? found}`,
      gadget: {
        version: GADGET_CONTRACT_VERSION,
        ...supplied,
        // Overwritten last, so a producer cannot set them.
        gadgetId: suppliedId ?? `${options.idPrefix}-${found}`,
        scope: options.scope,
        issuedAt: options.issuedAt
      }
    });
  }

  pushMarkdown(blocks, text.slice(lastIndex), `${options.idPrefix}-md-${mdIndex++}`);
  return { blocks, containsGadget: found > 0, malformed };
}
