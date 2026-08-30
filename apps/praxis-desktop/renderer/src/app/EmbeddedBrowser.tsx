import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';

/**
 * The subset of Electron's `<webview>` element this component drives. The tag
 * is enabled by `webviewTag: true` on the main window; every guest is hardened
 * in the main process (`hardenWebviewGuests`), so nothing here is trusted to
 * keep the page sandboxed.
 */
interface WebviewElement extends HTMLElement {
  src: string;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
}

/**
 * One request to show a page. The token is what makes clicking the *same* link
 * twice a navigation: after the user has browsed on inside the pane, the URL
 * alone no longer changes, so a bare `url` prop would silently do nothing.
 */
export interface BrowserRequest {
  url: string;
  token: number;
}

export interface EmbeddedBrowserProps {
  request: BrowserRequest;
  onClose: () => void;
}

/** Accepts what a user types in the address bar: bare hosts get a scheme. */
function normalizeTypedUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return undefined; // any other scheme is refused
  return `https://${trimmed}`;
}

/**
 * A minimal browser pane: an Electron `<webview>` guest plus the controls a
 * page needs to be usable — back/forward, reload/stop, an editable address,
 * and an escape hatch to the system browser. Rendered in the right-hand pane
 * when a link is opened from an AI session chat.
 *
 * The guest is an out-of-process web page, so the renderer's own CSP
 * (`default-src 'self'`) does not apply to it — that CSP is exactly why an
 * `<iframe>` cannot be used here, quite apart from `X-Frame-Options`.
 */
export function EmbeddedBrowser({ request, onClose }: EmbeddedBrowserProps) {
  const viewRef = useRef<WebviewElement | null>(null);
  // The `src` attribute only ever carries the first URL; every later request
  // goes through `loadURL` so a repeat of the current URL still navigates.
  const initialUrlRef = useRef(request.url);
  const [attached, setAttached] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(request.url);
  const [addressDraft, setAddressDraft] = useState(request.url);
  const [editingAddress, setEditingAddress] = useState(false);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>();

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return undefined;

    const syncNavState = () => {
      setCanGoBack(view.canGoBack());
      setCanGoForward(view.canGoForward());
    };
    const onUrl = (event: Event) => {
      const url = (event as Event & { url?: string }).url ?? view.getURL();
      setCurrentUrl(url);
      if (!editingAddress) setAddressDraft(url);
      setLoadError(undefined);
      syncNavState();
    };
    const onStart = () => {
      setLoading(true);
      setLoadError(undefined);
    };
    const onStop = () => {
      setLoading(false);
      syncNavState();
    };
    const onReady = () => setAttached(true);
    const onTitle = (event: Event) => setTitle((event as Event & { title?: string }).title ?? '');
    const onFail = (event: Event) => {
      const detail = event as Event & { errorCode?: number; errorDescription?: string; isMainFrame?: boolean };
      // -3 is ERR_ABORTED — a superseded navigation, not a failure the user
      // did anything to cause. Sub-frame failures are the page's business.
      if (detail.errorCode === -3 || detail.isMainFrame === false) return;
      setLoadError(detail.errorDescription || `Could not load this page (error ${detail.errorCode ?? '?'}).`);
      setLoading(false);
    };

    view.addEventListener('dom-ready', onReady);
    view.addEventListener('did-start-loading', onStart);
    view.addEventListener('did-stop-loading', onStop);
    view.addEventListener('did-navigate', onUrl);
    view.addEventListener('did-navigate-in-page', onUrl);
    view.addEventListener('page-title-updated', onTitle);
    view.addEventListener('did-fail-load', onFail);
    return () => {
      view.removeEventListener('dom-ready', onReady);
      view.removeEventListener('did-start-loading', onStart);
      view.removeEventListener('did-stop-loading', onStop);
      view.removeEventListener('did-navigate', onUrl);
      view.removeEventListener('did-navigate-in-page', onUrl);
      view.removeEventListener('page-title-updated', onTitle);
      view.removeEventListener('did-fail-load', onFail);
    };
  }, [editingAddress]);

  // `loadURL` throws until the guest has attached and emitted `dom-ready`,
  // hence the gate: before that the `src` attribute is already loading the
  // first URL anyway.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !attached) return;
    if (view.getURL() === request.url) return;
    setLoadError(undefined);
    setAddressDraft(request.url);
    void view.loadURL(request.url).catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : String(error));
    });
  }, [request, attached]);

  const navigate = useCallback((raw: string) => {
    const url = normalizeTypedUrl(raw);
    const view = viewRef.current;
    if (!url || !view || !attached) {
      if (!url) setLoadError('Only http and https addresses can be opened here.');
      return;
    }
    setLoadError(undefined);
    void view.loadURL(url).catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : String(error));
    });
  }, [attached]);

  return (
    <div className="embedded-browser" data-testid="embedded-browser">
      <div className="embedded-browser-toolbar">
        <button
          className="icon-btn icon-btn-sm"
          aria-label="Back"
          title="Back"
          disabled={!canGoBack}
          onClick={() => viewRef.current?.goBack()}
        >
          <Icon name="arrow-left" size={14} />
        </button>
        <button
          className="icon-btn icon-btn-sm"
          aria-label="Forward"
          title="Forward"
          disabled={!canGoForward}
          onClick={() => viewRef.current?.goForward()}
        >
          <Icon name="arrow-right" size={14} />
        </button>
        <button
          className="icon-btn icon-btn-sm"
          aria-label={loading ? 'Stop loading' : 'Reload'}
          title={loading ? 'Stop loading' : 'Reload'}
          onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}
        >
          <Icon name={loading ? 'close' : 'refresh'} size={14} />
        </button>
        <input
          className="embedded-browser-address"
          data-testid="embedded-browser-address"
          aria-label="Address"
          spellCheck={false}
          value={addressDraft}
          onChange={event => setAddressDraft(event.target.value)}
          onFocus={event => {
            setEditingAddress(true);
            event.target.select();
          }}
          onBlur={() => {
            setEditingAddress(false);
            setAddressDraft(currentUrl);
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
              navigate(addressDraft);
            } else if (event.key === 'Escape') {
              setAddressDraft(currentUrl);
              event.currentTarget.blur();
            }
          }}
        />
        <button
          className="icon-btn icon-btn-sm"
          aria-label="Open in system browser"
          title="Open in system browser"
          onClick={() => void window.praxis.shell.openExternal(currentUrl)}
        >
          <Icon name="external-link" size={14} />
        </button>
        <button
          className="icon-btn icon-btn-sm"
          aria-label="Close browser"
          title="Close browser"
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      {title && (
        <div className="embedded-browser-title" data-testid="embedded-browser-title" title={title}>
          {title}
        </div>
      )}
      {loadError && (
        <div className="embedded-browser-error" data-testid="embedded-browser-error">
          <Icon name="warning" size={13} />
          <span>{loadError}</span>
        </div>
      )}

      <webview
        // A named persistent partition keeps the pages the user browses here
        // out of the app's own session (cookies, storage, cache), while still
        // surviving a relaunch so logins are not thrown away every restart.
        partition="persist:praxis-browser"
        // Popups are denied in main and turned into an in-place navigation, so
        // a `target=_blank` link keeps the user inside this pane.
        allowpopups
        className="embedded-browser-view"
        data-testid="embedded-browser-view"
        ref={(element: HTMLElement | null) => {
          viewRef.current = element as WebviewElement | null;
        }}
        src={initialUrlRef.current}
      />
    </div>
  );
}
