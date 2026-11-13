/**
 * Linear-time text helpers.
 *
 * These replace regular expressions that CodeQL flags as polynomial-ReDoS
 * (`/\/+$/`, `/^-+|-+$/g`, lazy `[\s\S]*?` fences, ...). Such patterns are
 * quadratic on adversarial input — and the input here is model output, user
 * text or URLs. Each helper is behaviourally identical to the regex it replaces
 * and walks the string once.
 */

/** Removes every trailing character that appears in `chars` (`/[chars]+$/`). */
export function stripTrailingChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/** Removes every trailing character for which `pred` holds. */
export function stripTrailingWhere(value: string, pred: (ch: string) => boolean): string {
  let end = value.length;
  while (end > 0 && pred(value[end - 1])) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

/** Removes every leading character that appears in `chars` (`/^[chars]+/`). */
export function stripLeadingChars(value: string, chars: string): string {
  let start = 0;
  while (start < value.length && chars.includes(value[start])) start += 1;
  return start === 0 ? value : value.slice(start);
}

/** `value.replace(/\/+$/, '')`. */
export function stripTrailingSlashes(value: string): string {
  return stripTrailingChars(value, '/');
}

/** `value.replace(/^c+|c+$/g, '')` for a single character `c`. */
export function trimRepeatedChar(value: string, char: string): string {
  return stripLeadingChars(stripTrailingChars(value, char), char);
}

/** Whether `ch` is matched by the regex class `\s`. */
export function isRegexWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

export interface FencedBody {
  /** Everything from the opening fence to the end of the closing fence. */
  full: string;
  /** The text between the opening fence (and whitespace after it) and the closing fence. */
  body: string;
}

/**
 * The first fenced block whose opening matches `opening` (a regex with no
 * unbounded quantifiers, e.g. /```json/i), up to the first closing ``` after the
 * whitespace that follows it. Equivalent to
 * `new RegExp(opening.source + '\\s*([\\s\\S]*?)```', flags).exec(text)`, but
 * linear: if the first opening has no closing fence, no later one can either.
 */
export function findFencedBody(text: string, opening: RegExp): FencedBody | undefined {
  const open = new RegExp(opening.source, opening.flags.replace(/[gy]/g, '')).exec(text);
  if (!open) return undefined;
  let pos = open.index + open[0].length;
  while (pos < text.length && isRegexWhitespace(text[pos])) pos += 1;
  const close = text.indexOf('```', pos);
  if (close === -1) return undefined;
  return { full: text.slice(open.index, close + 3), body: text.slice(pos, close) };
}

/**
 * Removes every `<tag ...</tag>` span, case-insensitively — the linear form of
 * `text.replace(/<tag[\s\S]*?<\/tag>/gi, '')`. An opening with no closing tag
 * is left in place, as the regex left it.
 */
export function stripTaggedBlocks(text: string, tag: string): string {
  const openRe = new RegExp(`<${tag}`, 'gi');
  const closeRe = new RegExp(`</${tag}>`, 'gi');
  let out = '';
  let pos = 0;
  for (;;) {
    openRe.lastIndex = pos;
    const open = openRe.exec(text);
    if (!open) break;
    closeRe.lastIndex = open.index + open[0].length;
    const close = closeRe.exec(text);
    if (!close) break;
    out += text.slice(pos, open.index);
    pos = close.index + close[0].length;
  }
  return out + text.slice(pos);
}
