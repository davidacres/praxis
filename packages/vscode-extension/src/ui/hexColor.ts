/** Parse #rgb or #rrggbb into components. Returns undefined if invalid. */
export function parseHexRgb(input: string | undefined): { r: number; g: number; b: number } | undefined {
  if (!input) {
    return undefined;
  }
  let h = input.trim();
  if (!h.startsWith('#')) {
    return undefined;
  }
  h = h.slice(1);
  if (h.length === 3) {
    h = h
      .split('')
      .map(c => c + c)
      .join('');
  }
  if (h.length !== 6 || !/^[0-9a-fA-F]+$/.test(h)) {
    return undefined;
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16)
  };
}

export function buildMetaPillInlineStyle(hex: string | undefined): string | undefined {
  const rgb = parseHexRgb(hex);
  if (!rgb) {
    return undefined;
  }
  const { r, g, b } = rgb;
  const hex6 = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  return `color: ${hex6}; background: rgba(${r}, ${g}, ${b}, 0.16); border-color: rgba(${r}, ${g}, ${b}, 0.35);`;
}

export function normalizeOptionalHexColor(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  const t = raw.trim();
  if (!t) {
    return undefined;
  }
  return parseHexRgb(t) ? t : undefined;
}
