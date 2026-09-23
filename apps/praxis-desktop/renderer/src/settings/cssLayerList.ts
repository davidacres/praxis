/** Splits a CSS layer list only at top-level commas (data URLs contain their own comma). */
export function splitCssLayers(value: string): string[] {
  const layers: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote) {
      if (character === quote && value[index - 1] !== '\\') quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth = Math.max(0, depth - 1);
    } else if (character === ',' && depth === 0) {
      const layer = value.slice(start, index).trim();
      if (layer) layers.push(layer);
      start = index + 1;
    }
  }
  const finalLayer = value.slice(start).trim();
  if (finalLayer) layers.push(finalLayer);
  return layers;
}
