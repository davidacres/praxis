import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '../ui/Icon';

interface SessionComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Called on Enter (Shift+Enter inserts a newline) and on the send button. */
  onSubmit: () => void;
  placeholder: string;
  /** The agent is mid-turn: the box is disabled and the send button becomes Cancel. */
  running?: boolean;
  onCancel?: () => void;
  cancelling?: boolean;
  /** Disables the box without implying the agent is running (a failed session). */
  disabled?: boolean;
  /** Base test id: the box is `<id>`, send is `<id>-send`, cancel is `<id>-cancel`. */
  testId: string;
  /** Chips or buttons for the left of the controls row. */
  children?: ReactNode;
}

/**
 * The message box under a session's conversation.
 *
 * It is the same card the Sessions console uses — `.composer` /
 * `.session-follow-up-composer`, the `.composer-input` that starts at one line
 * and grows with its content, and the `.composer-controls` row with the
 * arrow-up send and the red close-icon cancel — so a conversation that lives on
 * another page (the ticket review) types, sends and cancels the same way. The
 * Sessions console's own composer carries far more (pasted images, terminal
 * context, runtime chips, queued follow-ups) and is still built in
 * `SessionsPage`; the shared parts are the classes and this behaviour, so a
 * change to the card's look lands in both.
 */
export function SessionComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  running = false,
  onCancel,
  cancelling = false,
  disabled = false,
  testId,
  children
}: SessionComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  // Start at one line and grow with content (capped by the CSS max-height).
  // Reset to 'auto' first so deleting text shrinks the box again — `scrollHeight`
  // never reports less than the box's current height. Same as the console's.
  useEffect(() => {
    const node = inputRef.current;
    if (!node) return;
    // Mid-turn the box has nothing to do: collapse it (the `.is-collapsed` class
    // zeroes its padding and min-height too) so the card shrinks to its controls
    // row, exactly as the console's does.
    if (running) {
      node.style.height = '0px';
      return;
    }
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [value, running]);

  const inputDisabled = disabled || running;
  return (
    <div className="composer session-follow-up-composer" data-testid={`${testId}-composer`}>
      <textarea
        ref={inputRef}
        className={`composer-input session-follow-up-input${running ? ' is-collapsed' : ''}`}
        rows={1}
        data-testid={testId}
        value={value}
        disabled={inputDisabled}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && value.trim()) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <div className="composer-controls">
        {children}
        <span className="spacer" />
        {running ? (
          <button
            className="composer-send composer-send-cancel"
            aria-label="Cancel response"
            title={cancelling ? 'Cancelling…' : 'Cancel response'}
            data-testid={`${testId}-cancel`}
            disabled={cancelling || !onCancel}
            onClick={onCancel}
          >
            <Icon name="close" size={15} />
          </button>
        ) : (
          <button
            className="composer-send"
            aria-label="Send message"
            title="Send message"
            data-testid={`${testId}-send`}
            disabled={inputDisabled || !value.trim()}
            onClick={onSubmit}
          >
            <Icon name="arrow-up" size={15} />
          </button>
        )}
      </div>
    </div>
  );
}
