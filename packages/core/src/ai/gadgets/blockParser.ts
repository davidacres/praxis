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

export const GADGET_FENCE_LANGUAGE = 'praxis-gadget';

/** Cheap pre-check so a caller can skip parsing text that cannot contain one. */
export function mayContainGadget(text: string): boolean {
  return text.includes(GADGET_FENCE_LANGUAGE);
}

const FENCE = /^[ \t]*```[ \t]*praxis-gadget[ \t]*\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm;

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

    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1]);
    } catch {
      malformed += 1;
      pushMarkdown(blocks, `\`\`\`json\n${match[1].trim()}\n\`\`\``);
      continue;
    }

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
