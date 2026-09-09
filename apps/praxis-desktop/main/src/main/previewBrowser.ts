import { BrowserWindow, WebContentsView, session as electronSession } from 'electron';
import {
  BrowserDiagnosticsRecorder,
  evaluateAssertions,
  previewAccessBlockedReason,
  screenshotsMatch,
  summarizeOutcome,
  writeBrowserDiagnosticsBundle,
  writeScreenshot,
  type BrowserDiagnosticsBundle,
  type BrowserDiagnosticsBundleKey,
  type ConsoleLevel,
  type PreviewVerificationCheck,
  type PreviewVerificationOutcome,
  type PreviewVerificationSnapshot
} from '@praxis/core';
import { previewAccess } from './runManagerInstance';
import { browserDiagnosticsStorageRoot } from './browserDiagnosticsStorage';

/**
 * The Run preview surface (FX-BE-055/056 / TASK-146/147) — a `WebContentsView`,
 * same structural pattern as `aiBrowser.ts`, but a passive viewer rather than
 * something an agent drives: no click/type/snapshot, just navigate + show.
 * Every navigation, redirect, and subresource is checked against the shared
 * `previewAccess` registry via `previewAccessBlockedReason` — the same one
 * decision function TASK-145 built, applied at the three points its
 * acceptance criteria name: `will-navigate` (top-level open), `will-redirect`
 * (a redirect mid-navigation), and `webRequest.onBeforeRequest` (every
 * subresource the loaded page's own script pulls in).
 *
 * Hiding this view (`setVisible(false)` — what closing the preview tab in
 * the renderer does) never calls anything in `runManagerInstance.ts`: a
 * preview is a window onto an already-running managed service, and closing
 * that window must not stop the service it was looking at.
 *
 * Every `open(url)` re-derives which (project, run, service) owns the page
 * from `previewAccess.grantFor(url)` — the same registry the access check
 * itself uses — and starts a fresh `BrowserDiagnosticsRecorder` for it
 * (TASK-147): console messages and failed requests captured from here on
 * are attributed to that identity, never left ambiguous or attributed to
 * whatever page happened to be open before.
 */

/** Electron's documented `console-message` levels: 0 verbose, 1 info, 2 warning, 3 error. */
function mapConsoleLevel(level: number): ConsoleLevel {
  if (level >= 3) return 'error';
  if (level === 2) return 'warning';
  if (level === 1) return 'info';
  return 'log';
}

const PARTITION = 'persist:praxis-preview';
const MAX_TEXT = 12_000;
const SETTLE_MS = 350;

class PreviewBrowserManager {
  private view: WebContentsView | undefined;
  private host: BrowserWindow | undefined;
  private visible = false;
  private lastBounds = { x: 0, y: 0, width: 0, height: 0 };
  private recorder: BrowserDiagnosticsRecorder | undefined;
  private recorderKey: BrowserDiagnosticsBundleKey | undefined;

  private hostWindow(): BrowserWindow {
    const win =
      (this.host && !this.host.isDestroyed() ? this.host : undefined) ??
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find(w => !w.isDestroyed());
    if (!win) throw new Error('No window to host the preview.');
    return win;
  }

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
    ses.on('will-download', event => event.preventDefault());
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    // Only the top-level document is covered by will-navigate/will-redirect
    // below — everything else here is a subresource the previewed page's
    // own script pulled in (script, image, xhr/fetch, iframe, …), which is
    // exactly what "unapproved private subresource" in TASK-145's
    // acceptance criteria means to block.
    ses.webRequest.onBeforeRequest((details, callback) => {
      if (details.resourceType === 'mainFrame') {
        callback({});
        return;
      }
      callback({ cancel: Boolean(previewAccessBlockedReason(details.url, previewAccess)) });
    });
    // Diagnostics capture (TASK-147) — informational hooks, no callback to
    // make. Both are no-ops whenever `this.recorder` is unset (nothing
    // granted currently owns whatever page is loaded).
    ses.webRequest.onCompleted(details => {
      if (details.statusCode >= 400) {
        this.recorder?.recordNetworkFailure({ url: details.url, method: details.method, status: details.statusCode });
      }
    });
    ses.webRequest.onErrorOccurred(details => {
      this.recorder?.recordNetworkFailure({ url: details.url, method: details.method, error: details.error });
    });

    const wc = view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' })); // a preview never spawns a new window
    const guard = (event: Electron.Event, url: string): void => {
      if (previewAccessBlockedReason(url, previewAccess)) event.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('console-message', (_event, level, message) => {
      this.recorder?.recordConsole(mapConsoleLevel(level), message);
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return; // subresource failures are already covered by onErrorOccurred above
      this.recorder?.recordNetworkFailure({ url: validatedURL, method: 'GET', error: `${errorDescription} (${errorCode})` });
    });

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

  /** Hiding the view — what the renderer does when the user closes the preview tab. Deliberately touches nothing in `runManagerInstance.ts`. */
  setVisible(win: BrowserWindow, visible: boolean): void {
    const view = this.ensure(win);
    this.visible = visible;
    view.setVisible(visible);
  }

  private get wc(): Electron.WebContents {
    return this.ensure(this.hostWindow()).webContents;
  }

  async open(url: string): Promise<void> {
    const reason = previewAccessBlockedReason(url, previewAccess);
    if (reason) throw new Error(reason);
    // A fresh recorder per page: whoever granted this exact origin owns
    // whatever gets captured from here on, never whatever page (or whose
    // grant) was open before.
    const grant = previewAccess.grantFor(url);
    if (grant) {
      this.recorderKey = { projectId: grant.projectId, runId: grant.runId, serviceId: grant.serviceId };
      this.recorder = new BrowserDiagnosticsRecorder(this.recorderKey);
    } else {
      this.recorderKey = undefined;
      this.recorder = undefined;
    }
    await this.wc.loadURL(url);
  }

  currentUrl(): string | undefined {
    return this.view && !this.view.webContents.isDestroyed() ? this.view.webContents.getURL() : undefined;
  }

  private async waitForLoad(): Promise<void> {
    if (!this.wc.isLoadingMainFrame()) return;
    await new Promise<void>(resolve => {
      const done = () => {
        this.wc.off('did-stop-loading', done);
        this.wc.off('did-navigate', done);
        resolve();
      };
      this.wc.once('did-stop-loading', done);
      this.wc.once('did-navigate', done);
      setTimeout(done, 15_000);
    });
  }

  /** The main-content text of the currently loaded page — same bounded extraction `aiBrowser.ts` uses, for interaction-driven verification (TASK-149) to assert against. */
  async pageText(): Promise<string> {
    const text = await this.wc
      .executeJavaScript(
        `(() => {
          const root = document.querySelector('main, article, [role=main]') || document.body;
          const t = (root && root.innerText) || '';
          const clean = t.replace(/\\n{3,}/g, '\\n\\n').trim();
          return clean.length > ${MAX_TEXT} ? clean.slice(0, ${MAX_TEXT}) + '\\n\\n…[truncated]' : clean;
        })()`,
        true
      )
      .catch(() => '');
    return String(text ?? '');
  }

  /** Clicks the element carrying `data-praxis-ref="<ref>"` — a preview verification check (TASK-149) is expected to know its own refs (e.g. `#submit`, `[data-testid=checkout]`) rather than discovering them via a snapshot tool, unlike the AI-driven browser. */
  async click(ref: string): Promise<void> {
    const ok = await this.wc.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(ref)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()`,
      true
    );
    if (!ok) throw new Error(`No element matching "${ref}".`);
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    await this.waitForLoad();
  }

  async type(ref: string, text: string, submit: boolean): Promise<void> {
    const ok = await this.wc.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(ref)});
        if (!el) return false;
        el.focus();
        const value = ${JSON.stringify(text)};
        if (el.isContentEditable) { el.textContent = value; } else { el.value = value; }
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
    if (!ok) throw new Error(`No element matching "${ref}".`);
    await new Promise(resolve => setTimeout(resolve, SETTLE_MS));
    await this.waitForLoad();
  }

  /**
   * Screenshots the currently loaded page, folds it into the active
   * recorder's snapshot, persists the bundle, and returns it. `undefined`
   * when nothing granted currently owns the open page (nothing was ever
   * `open()`ed, or it opened to an origin with no resolvable grant).
   */
  async captureDiagnostics(): Promise<BrowserDiagnosticsBundle | undefined> {
    if (!this.recorder || !this.recorderKey || !this.view || this.view.webContents.isDestroyed()) return undefined;
    const capturedAt = new Date().toISOString();
    try {
      const image = await this.view.webContents.capturePage();
      const record = await writeScreenshot(browserDiagnosticsStorageRoot(), this.recorderKey, image.toPNG(), capturedAt);
      this.recorder.recordScreenshot(record);
    } catch (error) {
      this.recorder.recordScreenshot({
        presence: 'missing',
        capturedAt,
        missingReason: error instanceof Error ? error.message : String(error)
      });
    }
    const bundle = this.recorder.snapshot(capturedAt);
    await writeBrowserDiagnosticsBundle(browserDiagnosticsStorageRoot(), bundle);
    return bundle;
  }

  /**
   * Runs one preview verification check end to end (TASK-149): opens the
   * service's granted origin at `check.path`, runs its interactions in
   * order, then evaluates `check.assertions` against what was actually
   * observed (page text + everything the recorder captured during the run).
   * A screenshot is captured and compared against `baselineScreenshot`
   * (byte-identity only) purely as attached evidence — see
   * `previewVerification.ts`'s module comment: it never influences
   * `passed`, and a screenshot capture failure never fails the check either.
   */
  async runVerification(input: { projectId: string; check: PreviewVerificationCheck; baselineScreenshot?: Buffer }): Promise<PreviewVerificationOutcome> {
    const grant = previewAccess.grants().find(g => g.projectId === input.projectId && g.serviceId === input.check.serviceId);
    if (!grant) {
      throw new Error(`No active preview grant for service "${input.check.serviceId}" — its run must be started and ready first.`);
    }
    const path = input.check.path.startsWith('/') ? input.check.path : `/${input.check.path}`;
    await this.open(`${grant.origin}${path}`);

    for (const interaction of input.check.interactions) {
      if (interaction.kind === 'click') await this.click(interaction.selector);
      else if (interaction.kind === 'type') await this.type(interaction.selector, interaction.text, interaction.submit ?? false);
      else await new Promise(resolve => setTimeout(resolve, interaction.ms));
    }

    const bundle = this.recorder?.snapshot();
    const snapshot: PreviewVerificationSnapshot = {
      pageText: await this.pageText(),
      console: (bundle?.console ?? []).map(entry => ({ level: entry.level, message: entry.message })),
      network: (bundle?.network ?? []).map(entry => ({ url: entry.url, method: entry.method, status: entry.status, error: entry.error }))
    };
    const results = evaluateAssertions(input.check.assertions, snapshot);

    let screenshot: PreviewVerificationOutcome['screenshot'];
    if (this.recorder && this.recorderKey && this.view && !this.view.webContents.isDestroyed()) {
      try {
        const image = await this.view.webContents.capturePage();
        const png = image.toPNG();
        const record = await writeScreenshot(browserDiagnosticsStorageRoot(), this.recorderKey, png);
        const baselineComparison = input.baselineScreenshot ? (screenshotsMatch(png, input.baselineScreenshot) ? 'match' : 'differs') : 'no-baseline';
        screenshot = { path: record.path!, baselineComparison };
      } catch {
        // A screenshot is attached evidence, never the pass/fail signal — a capture failure here must not fail an otherwise-passing check.
      }
    }

    return summarizeOutcome({
      checkId: input.check.id,
      serviceId: input.check.serviceId,
      results,
      capturedAt: new Date().toISOString(),
      ...(screenshot ? { screenshot } : {})
    });
  }
}

let manager: PreviewBrowserManager | undefined;

export function getPreviewBrowser(): PreviewBrowserManager {
  if (!manager) manager = new PreviewBrowserManager();
  return manager;
}
