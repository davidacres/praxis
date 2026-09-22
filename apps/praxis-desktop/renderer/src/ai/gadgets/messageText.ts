/**
 * Renderer-side helpers for gadget fences inside a provider message.
 *
 * These duplicate a couple of tiny pure functions from core rather than
 * importing them: a *value* import from `@praxis/core` anywhere under
 * `renderer/src` only fails at `vite build`, with an unrelated-looking native
 * binding error (AGENTS.md; `scripts/checkCoreImports.cjs` enforces it).
 */

export const GADGET_FENCE_LANGUAGE = 'praxis-gadget';

/** Mirrors core's `mayContainGadget` — a cheap skip for text with no fence. */
export function mayContainGadget(text: string | undefined): boolean {
  return Boolean(text && text.includes(GADGET_FENCE_LANGUAGE));
}

/**
 * Mirrors core's fence in `blockParser.ts`: the opening fence may follow prose on
 * the same line, and the closing one may follow the JSON directly, but it must
 * end its line. Keep the two in step or a gadget renders *and* its raw JSON shows.
 */
const FENCE = /[ \t]*```[ \t]*praxis-gadget[ \t]*\r?\n[\s\S]*?```[ \t]*$/gm;
const MEMORY_CITATION_BLOCK = /(?:^|\r?\n)[ \t]*<oai-mem-citation\b[^>]*>[\s\S]*?(?:<\/oai-mem-citation>[ \t]*(?=\r?\n|$)|$)/gi;

/**
 * Remove gadget fences from the text shown in the transcript.
 *
 * The gadget itself renders directly beneath the message, so leaving the raw
 * JSON in the prose would show the user the same request twice — once as an
 * interactive surface and once as machine noise.
 */
export function stripGadgetFences(text: string): string {
  if (!mayContainGadget(text)) return text;
  FENCE.lastIndex = 0;
  return text.replace(FENCE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Remove provider transport metadata from user-facing assistant prose.
 *
 * The raw message event remains untouched for audit and diagnostics. Matching
 * through end-of-input also keeps a citation block hidden while its closing
 * tag is still arriving in a streamed response.
 */
export function stripInternalMessageMetadata(text: string): string {
  if (!text.includes('<oai-mem-citation')) return text;
  MEMORY_CITATION_BLOCK.lastIndex = 0;
  return text.replace(MEMORY_CITATION_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Prose that is safe and useful to show in a conversation surface. */
export function visibleMessageText(text: string): string {
  return stripInternalMessageMetadata(stripGadgetFences(text));
}

/** The block-ID prefix used for the nth message in a conversation. */
export function gadgetMessageKey(index: number): string {
  return `msg-${index}`;
}

const MESSAGE_KEY = /^(msg-\d+)-/;

/**
 * Group a session's blocks back under the message that asked for them.
 *
 * A gadget ID may itself contain dashes (a producer can supply its own), so the
 * prefix is matched against the minted `msg-<n>` shape rather than split on the
 * last dash.
 */
export function groupBlocksByMessage<T extends { blockId: string; type: string }>(
  blocks: readonly T[]
): Record<string, T[]> {
  const grouped: Record<string, T[]> = {};
  for (const block of blocks) {
    if (block.type === 'markdown') continue;
    const match = MESSAGE_KEY.exec(block.blockId);
    if (!match) continue;
    (grouped[match[1]] ??= []).push(block);
  }
  return grouped;
}
