import { BrowserWindow, WebContentsView, session as electronSession } from 'electron';
import {
  blockedBrowserUrlReason,
  BrowserDiagnosticsRecorder,
  writeScreenshot,
  type BrowserBridge,
  type BrowserDiagnosticsBundleKey,
  type BrowserDiagnosticsSummary,
  type BrowserElement,
  type BrowserPageState,
  type BrowserScreenshotResult
} from '@praxis/core';
import { browserDiagnosticsStorageRoot } from './browserDiagnosticsStorage';

/**
 * The single in-app browser surface the AI can drive and the user can watch.
 *
 * A `WebContentsView` (own `persist:praxis-ai-browser` partition, no Node, no
 * popups, downloads cancelled) is parented to the main window and positioned by
 * the renderer via `setBounds` — the React side draws a placeholder where the
 * native view should sit. `AiBrowserBridge` below is the `BrowserBridge` the
 * gateway browser tools call.
 *
 * Diagnostics capture (FX-BE-056 / TASK-148): unlike the Run preview surface
 * (`previewBrowser.ts`), this browser is one shared instance with no
 * project/run/service identity of its own to attribute evidence to — it is
 * scoped to the agent's own browsing session, not a managed service. A fixed
 * sentinel key keeps its captures in their own, clearly-labelled corner of
 * the same storage tree TASK-147 already built, rather than inventing a
 * second capture/storage subsystem for what is otherwise identical logic.
 */
const AI_BROWSER_DIAGNOSTICS_KEY: BrowserDiagnosticsBundleKey = { projectId: 'ai-browser', runId: 'session', serviceId: 'default' };

const PARTITION = 'persist:praxis-ai-browser';
const MAX_TEXT = 12_000;
const MAX_ELEMENTS = 150;
const SETTLE_MS = 350;
/** Test/dev seam so the e2e suite can point the browser at a local mock server. */
const ALLOW_PRIVATE_HOSTS = process.env.PRAXIS_BROWSER_ALLOW_LOOPBACK === '1';
const urlBlockReason = (url: string) => blockedBrowserUrlReason(url, { allowPrivateHosts: ALLOW_PRIVATE_HOSTS });

/** Electron's documented `console-message` levels: 0 verbose, 1 info, 2 warning, 3 error. */
function mapConsoleLevel(level: number): 'log' | 'info' | 'warning' | 'error' {
  if (level >= 3) return 'error';
  if (level === 2) return 'warning';
  if (level === 1) return 'info';
  return 'log';
}

export interface AiBrowserNavigationEvent {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

class AiBrowserManager {
  private view: WebContentsView | undefined;
  private host: BrowserWindow | undefined;
  private visible = false;
  private lastBounds = { x: 0, y: 0, width: 0, height: 0 };
  private recorder: BrowserDiagnosticsRecorder = new BrowserDiagnosticsRecorder(AI_BROWSER_DIAGNOSTICS_KEY);

  /**
   * The view must exist as soon as the agent drives it, which can happen before
   * the user opens the browser pane. Fall back to the focused / first window so
   * `navigate()` et al. can create + parent it on demand; it stays hidden until
   * the renderer calls `setVisible(true)`.
   */
  private hostWindow(): BrowserWindow {
    const win =
      (this.host && !this.host.isDestroyed() ? this.host : undefined) ??
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    if (!win) throw new Error('No window to host the in-app browser.');
    return win;
  }

  /** Ensures the view exists and is parented to `win`; returns it. */
  private ensure(win: BrowserWindow): WebContentsView {
    if (this.view && !this.view.webContents.isDestroyed()) {
      if (this.host !== win) {
        this.host?.contentView.removeChildView(this.view);
        win.contentView.addChildView(this.view);
        this.host = win;
      }
      return this.view;
    }

    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false
      }
    });
    this.view = view;
    this.host = win;
    win.contentView.addChildView(view);
    view.setVisible(this.visible);
    view.setBorderRadius(8);

    const ses = electronSession.fromPartition(PARTITION);
    // An LLM must not be able to pull files down through the embedded browser.
    ses.on('will-download', event => event.preventDefault());
    // Deny every gated capability (geolocation, camera, notifications, …).
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    // Diagnostics capture (TASK-148) — informational, no callback to make.
    ses.webRequest.onCompleted(details => {
      if (details.statusCode >= 400) {
        this.recorder.recordNetworkFailure({ url: details.url, method: details.method, status: details.statusCode });
      }
    });
    ses.webRequest.onErrorOccurred(details => {
      this.recorder.recordNetworkFailure({ url: details.url, method: details.method, error: details.error });
    });

    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      if (!urlBlockReason(url)) void wc.loadURL(url);
      return { action: 'deny' };
    });
    const guard = (event: Electron.Event, url: string) => {
      if (urlBlockReason(url)) event.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('console-message', (_event, level, message) => {
      this.recorder.recordConsole(mapConsoleLevel(level), message);
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return; // subresource failures are already covered by onErrorOccurred above
      this.recorder.recordNetworkFailure({ url: validatedURL, method: 'GET', error: `${errorDescription} (${errorCode})` });
    });

    const emit = (loading: boolean) => this.emitNavigation(loading);
    // A genuine cross-document navigation starts a fresh capture — whatever
    // console/network evidence accumulated belongs to the page that just
    // left, not the one arriving. An in-page (SPA route) transition keeps
    // accumulating into the same recorder; it's still "the same page load."
    wc.on('did-navigate', () => {
      this.recorder = new BrowserDiagnosticsRecorder(AI_BROWSER_DIAGNOSTICS_KEY);
      emit(false);
    });
    wc.on('did-navigate-in-page', () => emit(false));
    wc.on('did-start-loading', () => emit(true));
    wc.on('did-stop-loading', () => emit(false));
    wc.on('page-title-updated', () => emit(wc.isLoading()));

    return view;
  }

  attach(win: BrowserWindow): void {
    this.ensure(win);
  }

  setBounds(win: BrowserWindow, bounds: { x: number; y: number; width: number; height: number }): void {
    const view = this.ensure(win);
    this.lastBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height))
    };
    view.setBounds(this.lastBounds);
  }

  setVisible(win: BrowserWindow, visible: boolean): void {
    const view = this.ensure(win);
    this.visible = visible;
    view.setVisible(visible);
  }

  private emitNavigation(loading: boolean): void {
    if (!this.view || this.view.webContents.isDestroyed()) return;
    const wc = this.view.webContents;
    const payload: AiBrowserNavigationEvent = {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading
    };
    if (this.host && !this.host.isDestroyed()) {
      this.host.webContents.send('browser:didNavigate', payload);
    }
  }

  private get wc(): Electron.WebContents {
    const view = this.ensure(this.hostWindow());
    return view.webContents;
  }

  private async waitForLoad(): Promise<void> {
    const wc = this.wc;
    if (!wc.isLoadingMainFrame()) return;
    await new Promise<void>(resolve => {
      const done = () => {
        wc.off('did-stop-loading', done);
        wc.off('did-navigate', done);
        resolve();
      };
      wc.once('did-stop-loading', done);
      wc.once('did-navigate', done);
      setTimeout(done, 15_000);
    });
  }

  private async state(): Promise<BrowserPageState> {
    const wc = this.wc;
    const text = await wc
      .executeJavaScript(
        `(() => {
          // Prefer the main content region so nav bars, cookie banners and
          // footers don't pad every read.
          const root = document.querySelector('main, article, [role=main]') || document.body;
          const t = (root && root.innerText) || '';
          const clean = t.replace(/\\n{3,}/g, '\\n\\n').trim();
          return clean.length > ${MAX_TEXT}
            ? clean.slice(0, ${MAX_TEXT}) + '\\n\\n…[truncated at ${MAX_TEXT} chars]'
            : clean;
        })()`,
        true
      )
      .catch(() => '');
    return { url: wc.getURL(), title: wc.getTitle(), text: String(text ?? '') };
  }

  async navigate(url: string): Promise<BrowserPageState> {
    const reason = urlBlockReason(url);
    if (reason) throw new Error(reason);
    await this.wc.loadURL(url);
    await this.waitForLoad();
    return this.state();
  }

  async goBack(): Promise<void> {
    if (this.wc.navigationHistory.canGoBack()) {
      this.wc.navigationHistory.goBack();
      await this.waitForLoad();
    }
  }

  async goForward(): Promise<void> {
    if (this.wc.navigationHistory.canGoForward()) {
      this.wc.navigationHistory.goForward();
      await this.waitForLoad();
    }
  }

  async reload(): Promise<void> {
    this.wc.reload();
    await this.waitForLoad();
  }

  async read(): Promise<BrowserPageState> {
    return this.state();
  }

  async snapshot(filter?: string): Promise<{ state: BrowserPageState; elements: BrowserElement[] }> {
    const needle = (filter ?? '').toLowerCase();
    const raw = await this.wc
      .executeJavaScript(
        `(() => {
          const sel = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[contenteditable=""],[contenteditable=true]';
          const out = [];
          let i = 0;
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (r.width === 0 && r.height === 0) continue;
            if (style.visibility === 'hidden' || style.display === 'none') continue;
            const ref = 'e' + (++i);
            el.setAttribute('data-praxis-ref', ref);
            const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '').replace(/\\s+/g, ' ').trim().slice(0, 160);
            const role = el.getAttribute('role') || el.tagName.toLowerCase();
            const value = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') ? String(el.value || '').slice(0, 120) : '';
            out.push({ ref, role, name, value });
            if (out.length >= ${MAX_ELEMENTS}) break;
          }
          return out;
        })()`,
        true
      )
      .catch(() => []);
    const elements: BrowserElement[] = Array.isArray(raw)
      ? raw
          .map(e => ({ ref: String(e.ref), role: String(e.role), name: String(e.name), value: e.value ? String(e.value) : undefined }))
          .filter(e => !needle || `${e.name} ${e.value ?? ''}`.toLowerCase().includes(needle))
      : [];
    return { state: await this.state(), elements };
  }

  async click(ref: string): Promise<BrowserPageState> {
    const ok = await this.wc.executeJavaScript(
      `(() => {
        const el = document.querySelector('[data-praxis-ref=' + JSON.stringify(${JSON.stringify(ref)}) + ']');
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()`,
      true
    );
    if (!ok) throw new Error(`No element with ref "${ref}" — call browser_snapshot again.`);
    await new Promise(r => setTimeout(r, SETTLE_MS));
    await this.waitForLoad();
    return this.state();
  }

  async type(ref: string, text: string, submit: boolean): Promise<BrowserPageState> {
    const ok = await this.wc.executeJavaScript(
      `(() => {
        const el = document.querySelector('[data-praxis-ref=' + JSON.stringify(${JSON.stringify(ref)}) + ']');
        if (!el) return false;
        el.focus();
        const value = ${JSON.stringify(text)};
        if (el.isContentEditable) { el.textContent = value; }
        else { el.value = value; }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (${submit ? 'true' : 'false'}) {
          const form = el.form;
          if (form && form.requestSubmit) form.requestSubmit();
          else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
        }
        return true;
      })()`,
      true
    );
    if (!ok) throw new Error(`No element with ref "${ref}" — call browser_snapshot again.`);
    await new Promise(r => setTimeout(r, SETTLE_MS));
    await this.waitForLoad();
    return this.state();
  }

  currentState(): AiBrowserNavigationEvent | undefined {
    if (!this.view || this.view.webContents.isDestroyed()) return undefined;
    const wc = this.view.webContents;
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading()
    };
  }

  /** Console/network evidence captured since the last cross-document navigation (TASK-148). */
  async getDiagnostics(): Promise<BrowserDiagnosticsSummary> {
    const bundle = this.recorder.snapshot();
    return { console: bundle.console, network: bundle.network, truncated: bundle.truncated };
  }

  /** Screenshots the current page for the user — never returned to the model. */
  async captureScreenshot(): Promise<BrowserScreenshotResult> {
    if (!this.view || this.view.webContents.isDestroyed()) {
      return { captured: false, note: 'The in-app browser has no page open.' };
    }
    try {
      const image = await this.view.webContents.capturePage();
      const png = image.toPNG();
      await writeScreenshot(browserDiagnosticsStorageRoot(), AI_BROWSER_DIAGNOSTICS_KEY, png);
      const { width, height } = image.getSize();
      return { captured: true, note: `Screenshot captured (${width}x${height}, ${Math.round(png.length / 1024)} KB).` };
    } catch (error) {
      return { captured: false, note: `Could not capture a screenshot: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
}

let manager: AiBrowserManager | undefined;

export function getAiBrowser(): AiBrowserManager {
  if (!manager) manager = new AiBrowserManager();
  return manager;
}

/** The `BrowserBridge` the core browser tools drive, backed by the manager. */
export class AiBrowserBridge implements BrowserBridge {
  navigate(url: string) {
    return getAiBrowser().navigate(url);
  }
  read() {
    return getAiBrowser().read();
  }
  snapshot(filter?: string) {
    return getAiBrowser().snapshot(filter);
  }
  click(ref: string) {
    return getAiBrowser().click(ref);
  }
  type(ref: string, text: string, submit: boolean) {
    return getAiBrowser().type(ref, text, submit);
  }
  getDiagnostics() {
    return getAiBrowser().getDiagnostics();
  }
  captureScreenshot() {
    return getAiBrowser().captureScreenshot();
  }
}
