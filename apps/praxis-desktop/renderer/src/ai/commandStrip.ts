/** Pure helpers for the Command Strip composer style (concept 1). */

export interface StripCommand {
  name: string;
  description: string;
  inputHint?: string;
}

/** The palette only opens while the whole draft is one bare `/word` — typing a
 *  space or any other text commits the command to the prompt and closes it. */
export function stripCommandQuery(value: string): string | undefined {
  const match = /^\/([\w-]*)$/.exec(value);
  return match ? match[1] : undefined;
}

export function filterStripCommands(commands: readonly StripCommand[], query: string): StripCommand[] {
  const needle = query.replace(/^\/+/, '').toLowerCase();
  return commands.filter(command => command.name.replace(/^\/+/, '').toLowerCase().startsWith(needle));
}

/** Commands are plain prompt text (see `insertAcpCommand`): picking one fills
 *  the composer with `/name ` and nothing runs until the user sends it. */
export function applyStripCommand(name: string): string {
  return `/${name.replace(/^\/+/, '')} `;
}

/** The strip's quiet token estimate, matching the concept mockup's ~4 chars/token. */
export function estimateStripTokens(value: string): number {
  return value.length === 0 ? 0 : Math.ceil(value.length / 4);
}

/** The tools row reveals once there is a real draft, but stays closed while the
 *  command palette is up so the two surfaces never compete. */
export function stripToolsExpanded(value: string): boolean {
  return value.trim().length > 0 && stripCommandQuery(value) === undefined;
}
