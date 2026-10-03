import type { PageAssistantContext } from '@praxis/core';
import { Icon } from '../ui/Icon';

interface AssistantContextBannerProps {
  /** The registered page context, even while detached, so the pill can offer re-attach. */
  context?: PageAssistantContext;
  detached: boolean;
  onToggleDetached: () => void;
  prompts: string[];
  busy: boolean;
  onPrompt: (prompt: string) => void;
}

/** The context pill (`✕ Context: Issue X`) and the page's quick-prompt chips. */
export function AssistantContextBanner({ context, detached, onToggleDetached, prompts, busy, onPrompt }: AssistantContextBannerProps) {
  return (
    <div className="assistant-context-row">
      {context && (
        <button
          type="button"
          className={`assistant-context-pill${detached ? ' is-detached' : ''}`}
          data-testid="assistant-context-pill"
          aria-label={detached ? `Attach context: ${context.title}` : `Detach context: ${context.title}`}
          title={detached ? 'Detached for the next message only — click to keep it attached' : 'Click to send the next message without this page context'}
          onClick={onToggleDetached}
        >
          <Icon name={detached ? 'plus' : 'close'} size={10} />
          <span>Context: {context.title}</span>
        </button>
      )}
      {prompts.length > 0 && (
        <div className="assistant-suggestions" data-testid="assistant-suggestions">
          {prompts.map(prompt => (
            <button key={prompt} type="button" className="assistant-chip" disabled={busy} onClick={() => onPrompt(prompt)}>{prompt}</button>
          ))}
        </div>
      )}
    </div>
  );
}
