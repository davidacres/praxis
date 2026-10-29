import {
  createContext, forwardRef, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState,
  type HTMLAttributes, type KeyboardEvent, type MutableRefObject, type ReactNode, type TextareaHTMLAttributes
} from 'react';

/** A phrase in the draft the prompt coach is unsure about, as a range of the input's value. */
export interface PromptHighlight { id: string; start: number; end: number; question: string; active?: boolean }
/** Text the coach would insert, drawn faintly after the draft until it is accepted. */
export interface PromptGhost { text: string; hint: string }
/** `ok` = the clarity check ran and found nothing to suggest. */
export type PromptAnalysisStatus = 'idle' | 'issues' | 'ok';
/** Returns true when the coach used the key, so the composer's own handler (Enter sends) never sees it. */
export type PromptKeyHandler = (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;

interface PromptAnalysisContextValue {
  highlights: readonly PromptHighlight[];
  setHighlights: (highlights: readonly PromptHighlight[]) => void;
  ghost?: PromptGhost;
  setGhost: (ghost: PromptGhost | undefined) => void;
  setStatus: (status: PromptAnalysisStatus) => void;
  /** Bumps `nonce` so selecting the same phrase twice still reopens its question. */
  requested?: { id: string; nonce: number };
  requestPhrase: (id: string) => void;
  keyHandler: MutableRefObject<PromptKeyHandler | undefined>;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
}

const noop = () => {};
const PromptAnalysisContext = createContext<PromptAnalysisContextValue>({
  highlights: [], setHighlights: noop, setGhost: noop, setStatus: noop, requestPhrase: noop,
  keyHandler: { current: undefined }, inputRef: { current: null }
});

/** The score bar publishes into, and the input reads from, the card both sit in. */
export const usePromptAnalysis = () => useContext(PromptAnalysisContext);

/** Shared visual frame for a draft, an active session and an embedded review. */
export function SessionComposerCard({ className = '', children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const [highlights, setHighlightsState] = useState<readonly PromptHighlight[]>([]);
  const [ghost, setGhostState] = useState<PromptGhost>();
  const [status, setStatus] = useState<PromptAnalysisStatus>('idle');
  const [requested, setRequested] = useState<{ id: string; nonce: number }>();
  const keyHandler = useRef<PromptKeyHandler | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const setHighlights = useCallback((next: readonly PromptHighlight[]) => {
    setHighlightsState(previous => sameHighlights(previous, next) ? previous : next);
  }, []);
  const setGhost = useCallback((next: PromptGhost | undefined) => {
    setGhostState(previous => previous?.text === next?.text && previous?.hint === next?.hint ? previous : next);
  }, []);
  const requestPhrase = useCallback((id: string) => setRequested(previous => ({ id, nonce: (previous?.nonce ?? 0) + 1 })), []);
  const value = useMemo(() => ({ highlights, setHighlights, ghost, setGhost, setStatus, requested, requestPhrase, keyHandler, inputRef }),
    [highlights, setHighlights, ghost, setGhost, requested, requestPhrase]);
  return <PromptAnalysisContext.Provider value={value}>
    <div {...props} data-prompt-analysis={status} className={`composer session-follow-up-composer ${className}`.trim()}>{children}</div>
  </PromptAnalysisContext.Provider>;
}

function sameHighlights(a: readonly PromptHighlight[], b: readonly PromptHighlight[]): boolean {
  return a.length === b.length && a.every((h, i) => h.id === b[i].id && h.start === b[i].start && h.end === b[i].end
    && h.question === b[i].question && h.active === b[i].active);
}

export function SessionComposerHeader(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`session-mode-panel ${props.className ?? ''}`.trim()} />;
}

/** Text metrics the highlight layer must share with the textarea for its marks to line up. */
const MIRRORED_STYLES = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'tabSize', 'textIndent',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing'
] as const;

/** One-line input that grows and shrinks with its content on every surface. */
export const SessionComposerInput = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & { collapsed?: boolean }>(
  function SessionComposerInput({ collapsed = false, className = '', value, onClick, onScroll, onKeyDown, ...props }, forwardedRef) {
    const input = useRef<HTMLTextAreaElement | null>(null);
    const backdrop = useRef<HTMLDivElement | null>(null);
    const { highlights, ghost, requestPhrase, keyHandler, inputRef } = usePromptAnalysis();
    const text = typeof value === 'string' ? value : '';
    // Only marks that still sit on the same words: a stale report must not underline the wrong text
    const marks = highlights.filter(h => h.start >= 0 && h.end <= text.length && h.end > h.start);
    const shownGhost = ghost && !collapsed && text.trim() ? ghost : undefined;
    useLayoutEffect(() => {
      const field = input.current, layer = backdrop.current;
      if (!field) return;
      if (layer) {
        const computed = getComputedStyle(field);
        for (const key of MIRRORED_STYLES) layer.style[key] = computed[key];
        // A scrollbar narrows the textarea's text box; the layer has none, so match the width
        layer.style.right = `${field.offsetWidth - field.clientWidth - parseFloat(computed.borderLeftWidth) - parseFloat(computed.borderRightWidth)}px`;
      }
      field.style.height = collapsed ? '0px' : 'auto';
      if (collapsed) return;
      // Ghost text can run past the draft's last line: grow the box so it is not clipped
      field.style.height = `${Math.max(field.scrollHeight, layer?.scrollHeight ?? 0)}px`;
      if (layer) layer.scrollTop = field.scrollTop;
    }, [value, collapsed, shownGhost?.text, marks.length]);
    // The textarea sits above the marks, so a click lands on it: map the caret back to a phrase
    const selectPhraseAtCaret = () => {
      const field = input.current;
      if (!field || field.selectionStart !== field.selectionEnd) return;
      const hit = marks.find(h => field.selectionStart >= h.start && field.selectionStart <= h.end);
      if (hit) requestPhrase(hit.id);
    };
    let pieces: ReactNode[] | undefined;
    if (marks.length || shownGhost) {
      pieces = [];
      let end = 0;
      for (const mark of [...marks].sort((a, b) => a.start - b.start)) {
        if (mark.start < end) continue;
        pieces.push(text.slice(end, mark.start));
        pieces.push(<mark key={mark.id} className={`composer-input-phrase${mark.active ? ' is-active' : marks.some(m => m.active) ? ' is-dim' : ''}`}
          data-testid={`prompt-phrase-${mark.id}`} title={mark.question}>{text.slice(mark.start, mark.end)}</mark>);
        end = mark.end;
      }
      pieces.push(text.slice(end));
      if (shownGhost) {
        const rest = text.slice(end);
        // The draft's own trailing space already separates the ghost from the last word
        const ghostText = /\s$/.test(rest || text) ? shownGhost.text.replace(/^ +/, '') : shownGhost.text;
        pieces.push(<span key="ghost" className="composer-input-ghost" data-testid="prompt-ghost-text">{ghostText}</span>);
        pieces.push(<span key="ghost-hint" className="composer-input-ghost-hint">{shownGhost.hint}</span>);
      } else {
        // A trailing newline collapses in the layer unless something follows it
        pieces.push('\u200b');
      }
    }
    return <div className={`composer-input-shell${marks.length ? ' has-highlights' : ''}${shownGhost ? ' has-ghost' : ''}`}>
      {pieces && <div ref={backdrop} className="composer-input-highlights" aria-hidden="true">{pieces}</div>}
      <textarea {...props} value={value} rows={1}
        className={`composer-input session-follow-up-input${collapsed ? ' is-collapsed' : ''} ${className}`.trim()}
        onClick={event => { onClick?.(event); selectPhraseAtCaret(); }}
        onKeyDown={event => {
          if (!event.nativeEvent.isComposing && keyHandler.current?.(event)) { event.preventDefault(); return; }
          onKeyDown?.(event);
        }}
        onScroll={event => { onScroll?.(event); if (backdrop.current) backdrop.current.scrollTop = event.currentTarget.scrollTop; }}
        ref={node => {
          input.current = node;
          inputRef.current = node;
          if (typeof forwardedRef === 'function') forwardedRef(node);
          else if (forwardedRef) forwardedRef.current = node;
        }} />
    </div>;
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
