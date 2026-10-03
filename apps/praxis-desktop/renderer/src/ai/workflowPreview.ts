export function workflowPreview(text: string): string {
  const characters = Array.from(text);
  return characters.length > 50 ? `${characters.slice(0, 49).join('')}…` : text;
}

