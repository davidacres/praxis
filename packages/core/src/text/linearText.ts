/**
 * Small linear-time text helpers that stand in for regexes such as `/^-+|-+$/g`
 * or `/<([^>]+)>;\s*rel="next"/`. Those shapes backtrack quadratically on long
 * runs of the repeated character (CodeQL: js/polynomial-redos); these scan once.
 */

/** Removes leading characters that appear in `chars`. */
export function trimLeadingChars(value: string, chars: string): string {
  let start = 0;
  while (start < value.length && chars.includes(value[start])) start++;
  return start === 0 ? value : value.slice(start);
}

/** Removes trailing characters that appear in `chars`. */
export function trimTrailingChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end--;
  return end === value.length ? value : value.slice(0, end);
}

/** Removes leading and trailing characters that appear in `chars`. */
export function trimEdgeChars(value: string, chars: string): string {
  return trimTrailingChars(trimLeadingChars(value, chars), chars);
}

const NEXT_REL = /;\s*rel="next"/y;

/**
 * The URL of a `<url>; rel="next"` Link-header entry, if `part` is one. Equivalent to
 * `/<([^>]+)>;\s*rel="next"/.exec(part)?.[1]` without the quadratic scan over repeated `<`.
 */
export function parseNextLinkEntry(part: string): string | undefined {
  let from = 0;
  for (;;) {
    const close = part.indexOf('>', from);
    if (close < 0) return undefined;
    // Every `<` before the first `>` shares that `>`; the first one with a character after it wins.
    const open = part.indexOf('<', from);
    if (open >= 0 && open + 1 < close) {
      NEXT_REL.lastIndex = close + 1;
      if (NEXT_REL.test(part)) return part.slice(open + 1, close);
    }
    from = close + 1;
  }
}
