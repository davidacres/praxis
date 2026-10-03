import { useEffect, useState } from 'react';
import { PERSONAS, type PersonaMeta } from './personaMeta';

/** The `@partial` token ending at the caret, if any. */
function mentionQuery(text: string, caret: number): { start: number; query: string } | undefined {
  const match = /(^|\s)@(\w*)$/.exec(text.slice(0, caret));
  return match ? { start: caret - match[2].length - 1, query: match[2].toLowerCase() } : undefined;
}

export interface AssistantMention {
  open: boolean;
  matches: readonly PersonaMeta[];
  highlight: number;
  setHighlight: (update: (current: number) => number) => void;
  /** Replaces the `@partial` before the caret with `@id ` and returns the new text and caret. */
  insert: (id: string) => { text: string; caret: number } | undefined;
  dismiss: () => void;
}

/** `@` autocomplete over the team roster, driven by the textarea's value and caret. */
export function useAssistantMention(value: string, caret: number): AssistantMention {
  const [dismissedAt, setDismissedAt] = useState<number | undefined>();
  const [highlight, setHighlightState] = useState(0);
  const mention = mentionQuery(value, caret);
  const matches = mention && dismissedAt !== mention.start ? PERSONAS.filter(persona => persona.id.startsWith(mention.query)) : [];
  useEffect(() => setHighlightState(0), [mention?.query]);
  return {
    open: matches.length > 0,
    matches,
    highlight,
    setHighlight: update => setHighlightState(update),
    insert: id => {
      if (!mention) return undefined;
      return { text: `${value.slice(0, mention.start)}@${id} ${value.slice(caret)}`, caret: mention.start + id.length + 2 };
    },
    dismiss: () => setDismissedAt(mention?.start)
  };
}
