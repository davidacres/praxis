import { BrowserWindow, session as electronSession } from 'electron';
import { consoleHosts, type AlibabaConsoleRegion, type AlibabaConsoleTransport } from './alibabaCodingPlanUsage';

/**
 * The Alibaba Cloud console session Praxis reads Coding Plan quota through.
 *
 * It lives in its own persistent partition: the person signs in once in a
 * Praxis window (`signInToAlibabaConsole`), the console sets its cookies there,
 * and the usage adapter reads them back for its requests. Nothing is copied
 * from the person's own browser, and nothing in this partition is reachable
 * from the app renderer or any other Praxis browser surface.
 */
const PARTITION = 'persist:alibaba-console';

/** Cookies that exist only once a console sign-in has completed. */
const LOGIN_COOKIES = ['login_aliyunid_ticket', 'login_aliyunid', 'login_current_pk'];

function consoleSession(): Electron.Session {
  return electronSession.fromPartition(PARTITION);
}

/** Every cookie the console session holds for the region's hosts, as one header. */
export async function alibabaConsoleCookieHeader(region: AlibabaConsoleRegion): Promise<string | undefined> {
  const hosts = consoleHosts(region);
  const seen = new Map<string, string>();
  for (const url of [hosts.gateway, hosts.rpcBase, hosts.dashboard]) {
    for (const cookie of await consoleSession().cookies.get({ url })) {
      if (!seen.has(cookie.name)) seen.set(cookie.name, cookie.value);
    }
  }
  if (seen.size === 0) return undefined;
  return [...seen].map(([name, value]) => `${name}=${value}`).join('; ');
}

export async function isAlibabaConsoleSignedIn(region: AlibabaConsoleRegion): Promise<boolean> {
  const header = await alibabaConsoleCookieHeader(region);
  return Boolean(header && LOGIN_COOKIES.some(name => header.includes(`${name}=`)));
}

export async function signOutOfAlibabaConsole(): Promise<void> {
  await consoleSession().clearStorageData();
}

export const alibabaConsoleTransport: AlibabaConsoleTransport = {
  cookieHeader: alibabaConsoleCookieHeader,
  fetch: (input, init) => fetch(input, init)
};

let openWindow: BrowserWindow | undefined;
let sessionHardened = false;

/** HTTPS only — plain HTTP solely for the loopback mock console the e2e suite points at. */
function allowedConsoleUrl(url: string): boolean {
  if (/^https:\/\//i.test(url)) return true;
  const override = process.env.PRAXIS_ALIBABA_CONSOLE_ORIGIN?.trim();
  return Boolean(override && url.startsWith(override));
}

/**
 * Opens the console's Coding Plan page in a sandboxed window on the console
 * partition and resolves when the person closes it. Sign-in may hop between
 * Alibaba's own login hosts and third-party identity providers, so navigation
 * is not pinned to one origin — but the window has no preload, no Node, and
 * never shares a session with the app.
 */
export async function signInToAlibabaConsole(region: AlibabaConsoleRegion, parent?: BrowserWindow): Promise<boolean> {
  if (openWindow && !openWindow.isDestroyed()) {
    openWindow.focus();
  } else {
    const ses = consoleSession();
    if (!sessionHardened) {
      sessionHardened = true;
      ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      ses.on('will-download', event => event.preventDefault());
    }
    const webPreferences: Electron.WebPreferences = {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    };
    const win = new BrowserWindow({
      width: 1100,
      height: 820,
      minWidth: 520,
      minHeight: 480,
      title: 'Sign in to Alibaba Cloud — Praxis',
      ...(parent && !parent.isDestroyed() ? { parent, modal: false } : {}),
      webPreferences
    });
    openWindow = win;
    // Identity-provider popups stay in the same locked-down session.
    win.webContents.setWindowOpenHandler(({ url }) =>
      allowedConsoleUrl(url) ?{ action: 'allow', overrideBrowserWindowOptions: { parent: win, webPreferences } } : { action: 'deny' }
    );
    win.webContents.on('will-navigate', (event, url) => {
      if (!allowedConsoleUrl(url)) event.preventDefault();
    });
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.on('closed', () => {
      if (openWindow === win) openWindow = undefined;
    });
    void win.loadURL(consoleHosts(region).dashboard);
  }
  const win = openWindow!;
  await new Promise<void>(resolve => win.once('closed', () => resolve()));
  return isAlibabaConsoleSignedIn(region);
}
