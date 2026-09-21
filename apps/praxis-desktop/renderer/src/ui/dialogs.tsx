import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';

/**
 * In-app replacements for `window.confirm` / `window.prompt`.
 *
 * The native dialogs are OS-modal, unstyleable, ignore every theme the app
 * ships, and block the renderer while open — and two of the prompts collected
 * real data (a branch name, a repository URL), so the moments where a typo
 * costs the most had no validation and no context. These render inside the
 * app's own modal surface instead, and return a promise so the call sites keep
 * reading like `const ok = await confirm(...)`.
 */

interface ConfirmOptions {
  title: string;
  message?: string;
  /** Short lines listed under the message — what exactly is affected. */
  details?: string[];
  /**
   * An opt-in checkbox for a *further, more destructive* action (unchecked every time). Only
   * `confirmWithOption` returns its state; the plain `confirm` ignores it.
   */
  option?: { label: string; hint?: string };
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PromptOptions {
  title: string;
  message?: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Return a string to show as an error and block confirmation; return undefined to allow it. */
  validate?: (value: string) => string | undefined;
}

interface DialogsApi {
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Like `confirm`, but also reports whether the `option` checkbox was ticked. Cancelling reports `checked: false`. */
  confirmWithOption: (options: ConfirmOptions) => Promise<{ confirmed: boolean; checked: boolean }>;
  prompt: (options: PromptOptions) => Promise<string | null>;
}

const DialogsContext = createContext<DialogsApi | null>(null);

type ActiveDialog =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (confirmed: boolean, checked: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

export function DialogHost({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<ActiveDialog>();
  const [draft, setDraft] = useState('');
  const [validationError, setValidationError] = useState<string>();
  const [optionChecked, setOptionChecked] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const confirmWithOption = useCallback(
    (options: ConfirmOptions) =>
      new Promise<{ confirmed: boolean; checked: boolean }>(resolve => {
        setOptionChecked(false);
        setActive({ kind: 'confirm', options, resolve: (confirmed, checked) => resolve({ confirmed, checked }) });
      }),
    []
  );

  const confirm = useCallback(
    (options: ConfirmOptions) => confirmWithOption(options).then(result => result.confirmed),
    [confirmWithOption]
  );

  const prompt = useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>(resolve => {
        setDraft(options.initialValue ?? '');
        setValidationError(undefined);
        setActive({ kind: 'prompt', options, resolve });
        // Focus after the modal has mounted.
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }),
    []
  );

  const api = useMemo<DialogsApi>(() => ({ confirm, confirmWithOption, prompt }), [confirm, confirmWithOption, prompt]);

  const close = (settle: () => void) => {
    settle();
    setActive(undefined);
  };

  const cancel = () => {
    if (!active) return;
    close(() => (active.kind === 'confirm' ? active.resolve(false, false) : active.resolve(null)));
  };

  const accept = () => {
    if (!active) return;
    if (active.kind === 'confirm') {
      close(() => active.resolve(true, optionChecked));
      return;
    }
    const value = draft.trim();
    const error = active.options.validate?.(value);
    if (error) {
      setValidationError(error);
      return;
    }
    close(() => active.resolve(value ? value : null));
  };

  return (
    <DialogsContext.Provider value={api}>
      {children}
      {active && (
        <div
          className="modal-overlay"
          onMouseDown={event => {
            if (event.target === event.currentTarget) cancel();
          }}
        >
          <div
            className="modal-card app-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={active.options.title}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                cancel();
              } else if (event.key === 'Enter' && active.kind === 'prompt') {
                event.preventDefault();
                accept();
              }
            }}
          >
            <div className="modal-header">
              <h3>{active.options.title}</h3>
              <button type="button" className="btn-icon" aria-label="Close" onClick={cancel}>
                <Icon name="close" size={13} />
              </button>
            </div>
            <div className="modal-body app-dialog-body">
              {active.options.message && <p className="app-dialog-message">{active.options.message}</p>}
              {active.kind === 'confirm' && active.options.details && active.options.details.length > 0 && (
                <ul className="app-dialog-details" data-testid="app-dialog-details">
                  {active.options.details.map(line => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
              {active.kind === 'confirm' && active.options.option && (
                <label className="app-dialog-option" data-testid="app-dialog-option">
                  <input
                    type="checkbox"
                    checked={optionChecked}
                    onChange={event => setOptionChecked(event.target.checked)}
                  />
                  <span>
                    <strong>{active.options.option.label}</strong>
                    {active.options.option.hint && <em>{active.options.option.hint}</em>}
                  </span>
                </label>
              )}
              {active.kind === 'prompt' && (
                <label className="app-dialog-field">
                  <span>{active.options.label}</span>
                  <input
                    ref={inputRef}
                    value={draft}
                    placeholder={active.options.placeholder}
                    onChange={event => {
                      setDraft(event.target.value);
                      if (validationError) setValidationError(undefined);
                    }}
                  />
                  {validationError && <span className="app-dialog-error">{validationError}</span>}
                </label>
              )}
            </div>
            <div className="modal-footer app-dialog-actions">
              <button type="button" className="btn" onClick={cancel}>
                {active.options.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                className={`btn ${active.kind === 'confirm' && active.options.danger ? 'btn-danger' : 'btn-primary'}`}
                onClick={accept}
              >
                {active.kind === 'confirm'
                  ? active.options.confirmLabel ?? 'Confirm'
                  : active.options.confirmLabel ?? 'OK'}
              </button>
            </div>
          </div>
        </div>
      )}
    </DialogsContext.Provider>
  );
}

/** `confirm` / `prompt` that render in-app. Requires a <DialogHost> ancestor. */
export function useDialogs(): DialogsApi {
  const api = useContext(DialogsContext);
  if (!api) {
    throw new Error('useDialogs must be used within a <DialogHost>');
  }
  return api;
}
