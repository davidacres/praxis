// Injected at document start into every page the in-app browser opens (`browser_native.rs`).
//
// Three jobs, none of which can use the app's IPC (a page's webview has no Tauri permissions):
//   1. buffer console output and failed requests so the host can pull them with `drain()`;
//   2. count input that only a person produces (`isTrusted`) so the host can tell a person from an
//      agent, whose actions below are synthetic events and never trusted;
//   3. read and drive the DOM for the agent tools: `read`, `snapshot`, `click`, `type`.
// The host reaches it through `eval_with_callback`, and everything it returns is plain JSON.
(() => {
  if (Object.prototype.hasOwnProperty.call(window, '__praxisBrowser')) return;
  const MAX_BUFFER = 100;
  const MAX_TEXT = 12000;
  const MAX_ELEMENTS = 150;
  const MAX_ENTRY = 4000;
  const consoleLog = [];
  const failures = [];
  let dropped = false;
  let input = 0;
  let documentStatusReported = false;

  const clip = value => {
    const text = String(value);
    return text.length > MAX_ENTRY ? text.slice(0, MAX_ENTRY) + '…' : text;
  };
  const push = (list, entry) => {
    list.push(entry);
    if (list.length > MAX_BUFFER) {
      list.shift();
      dropped = true;
    }
  };
  const at = () => new Date().toISOString();
  const describe = value => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.stack || value.message || String(value);
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  };
  const record = (level, args) => {
    try {
      push(consoleLog, { level, message: clip(Array.prototype.map.call(args, describe).join(' ')), at: at() });
    } catch (_) { /* never let capture break the page */ }
  };
  const fail = (url, method, status, error) =>
    push(failures, { url: clip(url), method, status, error, at: at() });

  for (const [name, level] of [['log', 'log'], ['info', 'info'], ['debug', 'log'], ['warn', 'warning'], ['error', 'error']]) {
    const original = console[name];
    if (typeof original !== 'function') continue;
    console[name] = function () {
      record(level, arguments);
      return original.apply(this, arguments);
    };
  }
  window.addEventListener('error', event => {
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) {
      fail(target.src || target.href, 'GET', undefined, 'resource failed to load (' + String(target.tagName).toLowerCase() + ')');
    } else {
      record('error', [event.message + (event.filename ? ' (' + event.filename + ':' + event.lineno + ')' : '')]);
    }
  }, true);
  window.addEventListener('unhandledrejection', event => record('error', ['Unhandled promise rejection: ' + describe(event.reason)]));

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (resource, init) {
      const method = ((init && init.method) || (resource && resource.method) || 'GET').toUpperCase();
      const url = typeof resource === 'string' ? resource : (resource && resource.url) || String(resource);
      return nativeFetch.apply(this, arguments).then(
        response => {
          if (response.status >= 400) fail(response.url || url, method, response.status);
          return response;
        },
        error => {
          fail(url, method, undefined, String((error && error.message) || error));
          throw error;
        }
      );
    };
  }
  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    const verb = String(method).toUpperCase();
    this.addEventListener('loadend', () => {
      if (this.status >= 400) fail(this.responseURL || String(url), verb, this.status);
      else if (this.status === 0) fail(String(url), verb, undefined, 'request failed');
    });
    return nativeOpen.apply(this, arguments);
  };

  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, event => { if (event.isTrusted) input += 1; }, { capture: true, passive: true });
  }

  const documentFailure = () => {
    if (documentStatusReported) return;
    try {
      const entry = performance.getEntriesByType('navigation')[0];
      if (!entry) return;
      documentStatusReported = true;
      if (entry.responseStatus >= 400) fail(location.href, 'GET', entry.responseStatus);
    } catch (_) { /* not supported */ }
  };

  const REF = 'data-praxis-ref';
  const find = ref => document.querySelector('[' + REF + '=' + JSON.stringify(String(ref)) + ']');

  const api = {
    /** Everything captured since the last drain, plus how much person input there has been. */
    drain() {
      documentFailure();
      const out = { console: consoleLog.splice(0), network: failures.splice(0), input, truncated: dropped };
      input = 0;
      dropped = false;
      return out;
    },
    read() {
      const root = document.querySelector('main, article, [role=main]') || document.body;
      const text = ((root && root.innerText) || '').replace(/\n{3,}/g, '\n\n').trim();
      return {
        url: location.href,
        title: document.title || '',
        text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n\n…[truncated at ' + MAX_TEXT + ' chars]' : text
      };
    },
    snapshot() {
      const selector = 'a[href],button,input:not([type=hidden]),textarea,select,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[contenteditable=""],[contenteditable=true]';
      const elements = [];
      for (const old of document.querySelectorAll('[' + REF + ']')) old.removeAttribute(REF);
      for (const el of document.querySelectorAll(selector)) {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (rect.width === 0 && rect.height === 0) continue;
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        const ref = 'e' + (elements.length + 1);
        el.setAttribute(REF, ref);
        const field = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
        const value = field ? String(el.value || '').slice(0, 120) : '';
        const name = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '')
          .replace(/\s+/g, ' ').trim().slice(0, 160);
        elements.push({ ref, role: el.getAttribute('role') || el.tagName.toLowerCase(), name, value });
        if (elements.length >= MAX_ELEMENTS) break;
      }
      return elements;
    },
    click(ref) {
      const el = find(ref);
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    },
    type(ref, value, submit) {
      const el = find(ref);
      if (!el) return false;
      el.focus();
      if (el.isContentEditable) {
        el.textContent = value;
      } else {
        // The native setter, so frameworks that track the value descriptor still see the change.
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, value);
        else el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (submit) {
        if (el.form && el.form.requestSubmit) el.form.requestSubmit();
        else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      }
      return true;
    }
  };
  Object.defineProperty(window, '__praxisBrowser', { value: Object.freeze(api), writable: false, configurable: false, enumerable: false });
})();
