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
import { GADGET_CONTRACT_VERSION, type GadgetScope } from './contracts';
import type { RawChatBlockInput } from './gadgetService';
import { parseLenientJson } from './jsonRepair';

export const GADGET_FENCE_LANGUAGE = 'praxis-gadget';

/** Cheap pre-check so a caller can skip parsing text that cannot contain one. */
export function mayContainGadget(text: string): boolean {
  return text.includes(GADGET_FENCE_LANGUAGE);
}

/**
 * A gadget fence. Models are loose about where it goes, so the opening fence may
 * follow prose on the same line ("…from the review.```praxis-gadget") and the
 * closing one may follow the JSON directly. The closing fence must end its line,
 * which is what keeps a "```" *inside* a JSON string (always mid-line, as the
 * JSON is one line) from ending the block early.
 */
const FENCE = /```[ \t]*praxis-gadget[ \t]*\r?\n([\s\S]*?)```[ \t]*$/gm;

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

function pushMarkdown(blocks: RawChatBlockInput[], text: string): void {
  const trimmed = text.trim();
  if (trimmed) blocks.push({ type: 'markdown', markdown: trimmed });
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

/**
 * Split `text` into ordered markdown and gadget blocks.
 *
 * A fence whose body is not JSON is preserved as a fenced code block rather
 * than dropped: the user sees exactly what the model produced, which is the
 * most debuggable outcome, and nothing silently disappears from a transcript.
 */
export function parseChatBlocks(text: string, options: ChatBlockParseOptions): ParsedChatBlocks {
  const blocks: RawChatBlockInput[] = [];
  let lastIndex = 0;
  let found = 0;
  let malformed = 0;

  FENCE.lastIndex = 0;
  for (let match = FENCE.exec(text); match !== null; match = FENCE.exec(text)) {
    pushMarkdown(blocks, text.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;
    found += 1;

    const lenient = parseLenientJson(match[1]);
    if (!lenient.ok) {
      malformed += 1;
      pushMarkdown(blocks, `\`\`\`json\n${match[1].trim()}\n\`\`\``);
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

  pushMarkdown(blocks, text.slice(lastIndex));
  return { blocks, containsGadget: found > 0, malformed };
}
