import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserNavigationState } from '@praxis/core';
import { Icon } from '../ui/Icon';

/**
 * The visible half of the in-app AI browser. The web content is a native
 * `WebContentsView` owned by the main process; this component only draws the
 * navigation toolbar and a placeholder whose on-screen rectangle it keeps
 * reporting to the main process (`browser:setBounds`) so the native view stays
 * pinned over it. Rendered inside the session console when the user opens it or
 * when the agent first drives the browser.
 */
export function BrowserPane({
  initialUrl,
  onNavigate,
  suspended = false,
  onClose
}: {
  initialUrl?: string;
  onNavigate?: (url: string) => void;
  suspended?: boolean;
  onClose?: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<BrowserNavigationState | undefined>();
  const [urlDraft, setUrlDraft] = useState('');
  const [editing, setEditing] = useState(false);

  // Kept in refs so the mount effect never re-subscribes / re-navigates when a
  // parent re-render hands us a new callback identity or the input focus flips.
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const restoredRef = useRef(false);

  const pushBounds = useCallback(() => {
    const el = surfaceRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    void window.praxis.browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
  }, []);

  useEffect(() => {
    void window.praxis.browser.attach();
    void window.praxis.browser.setVisible(!suspended);
    void window.praxis.browser.getState().then(s => {
      if (s) setState(s);
      // Restore a persisted URL exactly once, and only if we're not already there.
      if (!restoredRef.current && initialUrl && s?.url !== initialUrl) {
        restoredRef.current = true;
        void window.praxis.browser.navigate(initialUrl).catch(() => undefined);
      } else {
        restoredRef.current = true;
      }
    });

    const unsubscribe = window.praxis.browser.onDidNavigate(next => {
      setState(next);
      onNavigateRef.current?.(next.url);
      if (!editingRef.current) setUrlDraft(next.url);
    });

    pushBounds();
    const ro = new ResizeObserver(pushBounds);
    if (surfaceRef.current) ro.observe(surfaceRef.current);
    ro.observe(document.body);
    window.addEventListener('resize', pushBounds);
    // Splitter drags and pane toggles move the surface without resizing it;
    // a short poll while mounted keeps the native view aligned cheaply.
    const poll = window.setInterval(pushBounds, 250);

    return () => {
      unsubscribe();
      ro.disconnect();
      window.removeEventListener('resize', pushBounds);
      window.clearInterval(poll);
      void window.praxis.browser.setVisible(false);
    };
    // Mount once — callbacks and focus state are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void window.praxis.browser.setVisible(!suspended);
  }, [suspended]);

  const go = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const url = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    void window.praxis.browser.navigate(url).catch(() => undefined);
    setEditing(false);
  };

  return (
    <div className="browser-pane" data-testid="browser-pane">
      <div className="browser-toolbar">
        <button
          className="icon-btn icon-btn-sm"
          aria-label="Back"
          disabled={!state?.canGoBack}
          onClick={() => void window.praxis.browser.back()}
        >
          <Icon name="arrow-left" size={14} />
        </button>
        <button
          className="icon-btn icon-btn-sm"
          aria-label="Forward"
          disabled={!state?.canGoForward}
          onClick={() => void window.praxis.browser.forward()}
        >
          <Icon name="arrow-right" size={14} />
        </button>
        <button
          className="icon-btn icon-btn-sm"
          aria-label="Reload"
          onClick={() => void window.praxis.browser.reload()}
        >
          <Icon name="refresh" size={13} />
        </button>
        <input
          className="browser-url-input"
          data-testid="browser-url-input"
          value={editing ? urlDraft : state?.url ?? urlDraft}
          placeholder="Enter a URL"
          spellCheck={false}
          onFocus={() => { setEditing(true); setUrlDraft(state?.url ?? ''); }}
          onBlur={() => setEditing(false)}
          onChange={event => setUrlDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); go(urlDraft); event.currentTarget.blur(); }
            if (event.key === 'Escape') { setEditing(false); event.currentTarget.blur(); }
          }}
        />
        {state?.loading && <span className="browser-loading" aria-label="Loading" />}
        {onClose && (
          <button className="icon-btn icon-btn-sm" aria-label="Close browser" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        )}
      </div>
      <div className="browser-pane-surface" ref={surfaceRef} data-testid="browser-pane-surface">
        {!state?.url && (
          <div className="browser-pane-empty">
            <Icon name="globe" size={26} />
            <span>The agent&apos;s browser. Navigate here or ask the agent to open a page.</span>
          </div>
        )}
      </div>
    </div>
  );
}
