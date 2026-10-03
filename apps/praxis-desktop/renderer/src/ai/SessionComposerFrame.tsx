import { forwardRef, useLayoutEffect, useRef, type HTMLAttributes, type TextareaHTMLAttributes } from 'react';

/** Shared visual frame for a draft, an active session and an embedded review. */
export function SessionComposerCard({ className = '', ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`composer session-follow-up-composer ${className}`.trim()} />;
}

export function SessionComposerHeader(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`session-mode-panel ${props.className ?? ''}`.trim()} />;
}

/** One-line input that grows and shrinks with its content on every surface. */
export const SessionComposerInput = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { collapsed?: boolean }>(
  function SessionComposerInput({ collapsed = false, className = '', value, ...props }, forwardedRef) {
    const input = useRef<HTMLTextAreaElement | null>(null);
    useLayoutEffect(() => {
      if (!input.current) return;
      input.current.style.height = collapsed ? '0px' : 'auto';
      if (!collapsed) input.current.style.height = `${input.current.scrollHeight}px`;
    }, [value, collapsed]);
    return <textarea {...props} value={value} rows={1}
      className={`composer-input session-follow-up-input${collapsed ? ' is-collapsed' : ''} ${className}`.trim()}
      ref={node => {
        input.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }} />;
  }
);

/** The context meter shares its appearance before and after session creation. */
export function SessionContextRing({ percent }: { percent: number }) {
  return <svg viewBox="0 0 20 20" aria-hidden="true">
    <circle className="session-context-ring-track" cx="10" cy="10" r="7.5" />
    <circle className="session-context-ring-value" cx="10" cy="10" r="7.5"
      pathLength="100" strokeDasharray={`${percent} ${100 - percent}`} />
  </svg>;
}
