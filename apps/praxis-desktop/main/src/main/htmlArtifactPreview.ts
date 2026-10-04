import { randomUUID } from 'node:crypto';
import { BrowserWindow, session as electronSession } from 'electron';

const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "navigate-to 'none'"
].join('; ');
const PREVIEW_BOOTSTRAP = `<script>
document.addEventListener('click', event => {
  const target = event.target;
  const link = target instanceof Element ? target.closest('a') : null;
  if (link && !link.getAttribute('href')?.startsWith('#')) event.preventDefault();
}, true);
document.addEventListener('submit', event => event.preventDefault(), true);
</script>`;
function applyPreviewPolicy(source: string): string {
  // Do not let a source document's looser CSP override this preview's policy.
  const withoutCsp = source.replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy\b)[^>]*>/gi, '');
  const policy = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">${PREVIEW_BOOTSTRAP}`;
  const head = /<head\b[^>]*>/i;
  return head.test(withoutCsp)
    ? withoutCsp.replace(head, match => `${match}${policy}`)
    : `<!doctype html><html><head><meta charset="utf-8">${policy}</head><body>${withoutCsp}</body></html>`;
}

/** Opens generated HTML in a window with no app preload, Node access, network, or downloads. */
export async function openRestrictedHtmlPreview(
  source: string,
  requestedTitle: string,
  parent?: BrowserWindow
): Promise<void> {
  const previewSession = electronSession.fromPartition(`html-artifact-preview-${randomUUID()}`);
  let initialMainFrameAllowed = true;
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.on('will-download', event => event.preventDefault());
  previewSession.webRequest.onBeforeRequest((details, callback) => {
    if (details.resourceType === 'mainFrame') {
      const allowInitialDocument = initialMainFrameAllowed && details.url.startsWith('data:text/html');
      if (allowInitialDocument) initialMainFrameAllowed = false;
      callback({ cancel: !allowInitialDocument });
      return;
    }
    callback({ cancel: !/^(?:data|blob):/i.test(details.url) });
  });

  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 560,
    minHeight: 360,
    show: false,
    frame: true,
    title: `Preview — ${requestedTitle.replace(/[\r\n\0]/g, ' ').slice(0, 120) || 'HTML artifact'}`,
    ...(parent && !parent.isDestroyed() ? { parent, modal: false } : {}),
    webPreferences: {
      session: previewSession,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    }
  });

  const documentUrl = `data:text/html;charset=utf-8,${encodeURIComponent(applyPreviewPolicy(source))}`;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('will-frame-navigate', event => event.preventDefault());
  win.webContents.on('will-redirect', event => event.preventDefault());
  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.once('ready-to-show', () => win.show());
  await win.loadURL(documentUrl);
  if (!win.isDestroyed() && !win.isVisible()) win.show();
}
