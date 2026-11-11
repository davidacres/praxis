/** Escapes text for use inside a RegExp, so a name like "Plan (v2)" matches literally. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
