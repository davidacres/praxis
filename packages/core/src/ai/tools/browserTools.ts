import type { GatewayToolDefinition } from '../gateway';
import type { PermissionDecision } from './localTools';

/**
 * The in-app browser tools a full-tools gateway session can be granted (Settings
 * → AI Provider → "Let the AI use the in-app browser"). The model reads a page
 * with `browser_read` / `browser_snapshot` and acts on it by `ref` — the same
 * shape as Playwright-MCP and Claude-in-Chrome — so it never needs pixel
 * coordinates. Every `browser_navigate` to a host not on the allow-list prompts
 * the user; loopback and private-range hosts are always refused.
 */
export const BROWSER_TOOL_DEFINITIONS: GatewayToolDefinition[] = [
  {
    name: 'browser_navigate',
    description:
      'Open a URL in the in-app browser. Returns the resolved URL, page title, and a text excerpt. ' +
      'Navigating to a host that is not pre-approved asks the user to allow it first.',
    inputSchema: {
      type: 'object' as const,
      properties: { url: { type: 'string', description: 'Absolute http(s) URL.' } },
      required: ['url']
    }
  },
  {
    name: 'browser_read',
    description:
      'Read the current page as plain text (main content, scripts and chrome stripped). ' +
      'Use this to understand a page before acting on it.',
    inputSchema: { type: 'object' as const, properties: {} }
  },
  {
    name: 'browser_snapshot',
    description:
      'List the interactive elements on the current page — links, buttons, inputs, selects — each with a ' +
      'stable `ref`, its role, its visible label, and its current value. Pass a `ref` to browser_click / browser_type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filter: {
          type: 'string',
          description: 'Optional case-insensitive substring; only elements whose label/value contains it are returned.'
        }
      }
    }
  },
  {
    name: 'browser_click',
    description: 'Click the element with the given ref (from browser_snapshot), then return the updated page text.',
    inputSchema: {
      type: 'object' as const,
      properties: { ref: { type: 'string' } },
      required: ['ref']
    }
  },
  {
    name: 'browser_type',
    description:
      'Type text into the input/textarea with the given ref. Set submit=true to press Enter afterwards ' +
      '(e.g. to run a search). Returns the updated page text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ref: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean' }
      },
      required: ['ref', 'text']
    }
  }
];

export const BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set(
  BROWSER_TOOL_DEFINITIONS.map(tool => tool.name)
);

/** One interactive element in a page snapshot. */
export interface BrowserElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
}

export interface BrowserPageState {
  url: string;
  title: string;
  /** Readable main-content text, already truncated by the host. */
  text: string;
}

/**
 * The host-side browser the tools drive. Implemented in the desktop main process
 * against a `WebContentsView`; kept as an interface here so core stays free of
 * Electron and the logic below stays unit-testable.
 */
export interface BrowserBridge {
  navigate(url: string): Promise<BrowserPageState>;
  read(): Promise<BrowserPageState>;
  snapshot(filter?: string): Promise<{ state: BrowserPageState; elements: BrowserElement[] }>;
  click(ref: string): Promise<BrowserPageState>;
  type(ref: string, text: string, submit: boolean): Promise<BrowserPageState>;
}

const PRIVATE_IPV4 =
  /^(127\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Returns a rejection reason if this URL must never be opened, or `undefined` if
 * it is at least shaped acceptably (host-allow-list is checked separately). Keeps
 * an LLM from pointing the embedded browser at the loopback interface, the
 * private network, or the local filesystem.
 */
export function blockedBrowserUrlReason(
  rawUrl: string,
  options: { allowPrivateHosts?: boolean } = {}
): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'Not a valid absolute URL.';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Unsupported scheme "${url.protocol}" — only http and https are allowed.`;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isPrivate =
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    PRIVATE_IPV4.test(host);
  if (isPrivate && !options.allowPrivateHosts) {
    return `Refusing to open a loopback / private-network host (${host}).`;
  }
  return undefined;
}

/** Whether `url`'s host matches an entry in `allowedHosts` (exact or `*.suffix`). */
export function browserHostAllowed(rawUrl: string, allowedHosts: readonly string[]): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedHosts.some(entry => {
    const pattern = entry.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".example.com"
      return host === pattern.slice(2) || host.endsWith(suffix);
    }
    return host === pattern;
  });
}

function renderState(state: BrowserPageState): string {
  return `# ${state.title || '(untitled)'}\n${state.url}\n\n${state.text}`.trim();
}

function renderSnapshot(state: BrowserPageState, elements: BrowserElement[]): string {
  const header = `${state.title || '(untitled)'} — ${state.url}`;
  if (elements.length === 0) {
    return `${header}\n\n(no interactive elements found)`;
  }
  const lines = elements.map(el => {
    const value = el.value ? ` = ${JSON.stringify(el.value)}` : '';
    return `- [${el.ref}] ${el.role} "${el.name}"${value}`;
  });
  return `${header}\n\n${lines.join('\n')}`;
}

export interface BrowserToolContext {
  bridge: BrowserBridge;
  allowedHosts: readonly string[];
  /** Test/dev seam: permit loopback + private-range hosts (default false). */
  allowPrivateHosts?: boolean;
  /**
   * Ask the user to allow a navigation whose host is not on `allowedHosts`.
   * Resolves to the user's decision; `allow_always` also persists the host.
   */
  requestNavigatePermission(host: string, url: string): Promise<PermissionDecision>;
  /** Called after an `allow_always`, so the host can remember the host. */
  onHostAllowed?: (host: string) => void;
}

/**
 * Runs one browser tool call end to end: URL guard, host-allow-list check +
 * permission prompt, the `BrowserBridge` action, and result formatting. Shared
 * by the gateway `toolExtension` path and the ACP MCP-server path.
 */
export async function executeBrowserTool(
  name: string,
  args: Record<string, unknown>,
  ctx: BrowserToolContext
): Promise<{ ok: boolean; content: string }> {
  const str = (key: string) => (typeof args[key] === 'string' ? (args[key] as string).trim() : '');
  try {
    if (name === 'browser_navigate') {
      const url = str('url');
      if (!url) return { ok: false, content: 'url is required.' };
      const blocked = blockedBrowserUrlReason(url, { allowPrivateHosts: ctx.allowPrivateHosts });
      if (blocked) return { ok: false, content: blocked };
      if (!browserHostAllowed(url, ctx.allowedHosts)) {
        const host = new URL(url).hostname.toLowerCase();
        const decision = await ctx.requestNavigatePermission(host, url);
        if (decision === 'deny') {
          return { ok: false, content: `Permission denied to open ${url}. Ask the user to allow ${host} (Settings → AI Provider).` };
        }
        if (decision === 'allow_always') ctx.onHostAllowed?.(host);
      }
      return { ok: true, content: renderState(await ctx.bridge.navigate(url)) };
    }
    if (name === 'browser_read') {
      return { ok: true, content: renderState(await ctx.bridge.read()) };
    }
    if (name === 'browser_snapshot') {
      const { state, elements } = await ctx.bridge.snapshot(str('filter') || undefined);
      return { ok: true, content: renderSnapshot(state, elements) };
    }
    if (name === 'browser_click') {
      const ref = str('ref');
      if (!ref) return { ok: false, content: 'ref is required.' };
      return { ok: true, content: renderState(await ctx.bridge.click(ref)) };
    }
    if (name === 'browser_type') {
      const ref = str('ref');
      if (!ref) return { ok: false, content: 'ref is required.' };
      const text = typeof args.text === 'string' ? args.text : '';
      return { ok: true, content: renderState(await ctx.bridge.type(ref, text, args.submit === true)) };
    }
    return { ok: false, content: `Unknown browser tool: ${name}` };
  } catch (error) {
    return { ok: false, content: error instanceof Error ? error.message : String(error) };
  }
}

export interface BrowserToolExtensionOptions {
  bridge: BrowserBridge;
  allowedHosts: readonly string[];
  /** Called after a navigation the user allowed, so the host can remember the host. */
  onHostAllowed?: (host: string) => void;
  /** Test/dev seam: permit loopback + private-range hosts (default false). */
  allowPrivateHosts?: boolean;
}

/**
 * Builds the `toolExtension` object `VercelAgentService` expects: the browser
 * tool definitions plus a dispatcher wrapping `executeBrowserTool`.
 */
export function createBrowserToolExtension(options: BrowserToolExtensionOptions): {
  definitions: GatewayToolDefinition[];
  execute(
    name: string,
    args: Record<string, unknown>,
    requestPermission: (request: { kind: string; description: string; detail?: string }) => Promise<PermissionDecision>
  ): Promise<{ ok: boolean; content: string }>;
} {
  return {
    definitions: BROWSER_TOOL_DEFINITIONS,
    execute(name, args, requestPermission) {
      return executeBrowserTool(name, args, {
        bridge: options.bridge,
        allowedHosts: options.allowedHosts,
        allowPrivateHosts: options.allowPrivateHosts,
        onHostAllowed: options.onHostAllowed,
        requestNavigatePermission: (host, url) =>
          requestPermission({
            kind: 'browser-navigate',
            description: `Open ${host} in the in-app browser`,
            detail: url
          })
      });
    }
  };
}
