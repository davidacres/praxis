/**
 * Lenient parsing for a model's gadget JSON.
 *
 * A gadget is JSON written by a model, and models write JSON that a strict
 * parser refuses in a few predictable ways — most often a double quote inside a
 * string ("a \"System One\" wrapper" written as `a "System One" wrapper`) and a
 * raw newline inside a string. A refusal there costs the user the whole
 * decision, so the parser tries strict first and only then repairs those two
 * faults. Anything it cannot repair still fails, and the caller shows the text.
 *
 * The repair is deliberately narrow. It changes only what is *inside* a string
 * and never guesses at structure (missing braces, trailing commas), so it can
 * turn invalid JSON into JSON that means what the model plainly intended, but
 * cannot turn it into something else.
 */

/** Characters that may legitimately follow the closing quote of a string. */
const TERMINATORS = new Set([',', '}', ']', ':']);

function nextSignificant(text: string, from: number): string | undefined {
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (char !== ' ' && char !== '\t' && char !== '\r' && char !== '\n') return char;
  }
  return undefined;
}

/**
 * Escape the two string-internal faults. A quote ends a string only when what
 * follows it is JSON structure; otherwise it is text the model forgot to escape.
 */
export function repairJsonStrings(text: string): string {
  let out = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!inString) {
      if (char === '"') inString = true;
      out += char;
      continue;
    }
    if (char === '\\') {
      // Copy a valid escape pair whole; a lone trailing backslash is doubled.
      const next = text[index + 1];
      if (next === undefined) {
        out += '\\\\';
      } else {
        out += char + next;
        index += 1;
      }
      continue;
    }
    if (char === '"') {
      const following = nextSignificant(text, index + 1);
      if (following === undefined || TERMINATORS.has(following)) {
        inString = false;
        out += char;
      } else {
        out += '\\"';
      }
      continue;
    }
    if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else out += char;
  }
  return out;
}

export type LenientJson = { ok: true; value: unknown; repaired: boolean } | { ok: false; error: string };

/** Strict parse first; repair the string faults only if that fails. */
export function parseLenientJson(text: string): LenientJson {
  try {
    return { ok: true, value: JSON.parse(text), repaired: false };
  } catch (strictError) {
    try {
      return { ok: true, value: JSON.parse(repairJsonStrings(text)), repaired: true };
    } catch {
      return { ok: false, error: strictError instanceof Error ? strictError.message : String(strictError) };
    }
  }
}
