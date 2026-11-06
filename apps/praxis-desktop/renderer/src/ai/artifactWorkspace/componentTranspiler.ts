import reactUmd from './vendor/react.production.min.js?raw';
import reactDomUmd from './vendor/react-dom.production.min.js?raw';
import type { ActiveArtifact } from './artifactTypes';

export interface TranspileResult {
  js: string;
  mainComponentName?: string;
  error?: string;
}

/**
 * Transpiles TypeScript + JSX into plain JavaScript with React.createElement calls.
 */
export function transpileComponentCode(code: string): TranspileResult {
  try {
    // 1. Strip import statements and track Lucide / React imports
    let src = code.replace(/^\s*import\s+[^;\n]+;?/gm, '');

    // 2. Strip TypeScript interfaces and type aliases
    src = src.replace(/^\s*(?:export\s+)?interface\s+[\w<>]+\s*\{[\s\S]*?\}/gm, '');
    src = src.replace(/^\s*(?:export\s+)?type\s+[\w<>]+\s*=[\s\S]*?;/gm, '');

    // 3. Find exported component names
    let mainComponentName: string | undefined;
    const defaultExportMatch = src.match(/export\s+default\s+function\s+([A-Z][A-Za-z0-9_]*)/);
    if (defaultExportMatch?.[1]) {
      mainComponentName = defaultExportMatch[1];
    } else {
      const namedExportMatch = src.match(/export\s+(?:function|const)\s+([A-Z][A-Za-z0-9_]*)/);
      if (namedExportMatch?.[1]) {
        mainComponentName = namedExportMatch[1];
      } else {
        const functionMatch = src.match(/(?:function|const)\s+([A-Z][A-Za-z0-9_]*)/);
        if (functionMatch?.[1]) {
          mainComponentName = functionMatch[1];
        }
      }
    }

    // Strip "export default" and "export" keywords
    src = src.replace(/export\s+default\s+/g, '');
    src = src.replace(/export\s+/g, '');

    // 4. Strip TypeScript annotations
    src = src.replace(/:\s*(?:[A-Z][\w.<>[\]]*|string|number|boolean|any|void|unknown)(?:\[\])?(?=[\s,=)])/g, '');
    src = src.replace(/<[A-Z][\w, ]*>\s*(?=\()/g, '');
    src = src.replace(/\s+as\s+[A-Z][\w.<>[\]]*/g, '');

    // 5. Transform JSX
    const transformedJs = transformJsxTokens(src);
    return { js: transformedJs, mainComponentName };
  } catch (err) {
    return {
      js: code,
      error: err instanceof Error ? err.message : String(err)
    };
  }
}

function transformJsxTokens(src: string): string {
  let pos = 0;
  const len = src.length;

  function skipSpaces() {
    while (pos < len && /\s/.test(src[pos]!)) pos++;
  }

  function parseQuotedString(): string {
    const quote = src[pos]!;
    const start = pos;
    pos++;
    while (pos < len && src[pos] !== quote) {
      if (src[pos] === '\\') pos += 2;
      else pos++;
    }
    pos++; // skip closing quote
    return src.slice(start, pos);
  }

  function parseBracedExpr(): string {
    pos++; // skip "{"
    let depth = 1;
    const start = pos;
    while (pos < len && depth > 0) {
      if (src[pos] === '{') depth++;
      else if (src[pos] === '}') depth--;
      else if (src[pos] === '"' || src[pos] === "'" || src[pos] === '`') {
        parseQuotedString();
        continue;
      }
      if (depth === 0) break;
      pos++;
    }
    const expr = src.slice(start, pos);
    pos++; // skip "}"
    // Recursively transform JSX expressions inside braces (e.g. mapping or ternary)
    return transformJsxTokens(expr);
  }

  function parseChildren(closingTag: string): string[] {
    const children: string[] = [];
    while (pos < len) {
      if (src.slice(pos, pos + closingTag.length) === closingTag) {
        pos += closingTag.length;
        break;
      }
      if (src[pos] === '<' && src.slice(pos, pos + 2) !== '</') {
        const childNode = transformNode();
        if (childNode) children.push(childNode);
        else pos++;
      } else if (src[pos] === '{') {
        const expr = parseBracedExpr().trim();
        if (expr) children.push(expr);
      } else {
        const textStart = pos;
        while (pos < len && src[pos] !== '<' && src[pos] !== '{' && src.slice(pos, pos + closingTag.length) !== closingTag) {
          pos++;
        }
        const text = src.slice(textStart, pos);
        const normalized = text.replace(/[\r\n\t]+/g, ' ');
        if (normalized.trim().length > 0) {
          children.push(JSON.stringify(normalized));
        }
      }
    }
    return children;
  }

  function transformNode(): string | null {
    if (src.slice(pos, pos + 2) === '<>') {
      pos += 2;
      const children = parseChildren('</>');
      return `React.createElement(React.Fragment, null, ${children.join(', ')})`;
    }

    if (src[pos] !== '<' || src[pos + 1] === '/' || src[pos + 1] === '!' || !/^[A-Za-z0-9_.]/.test(src[pos + 1] || '')) {
      return null;
    }

    pos++; // skip "<"
    const tagMatch = src.slice(pos).match(/^[A-Za-z0-9_.]+/);
    if (!tagMatch) return null;
    const tagName = tagMatch[0];
    pos += tagName.length;

    const isDomTag = /^[a-z]/.test(tagName) && !tagName.includes('.');
    const tagExpr = isDomTag ? JSON.stringify(tagName) : tagName;

    const props: string[] = [];
    while (pos < len) {
      skipSpaces();
      if (src[pos] === '>' || src.slice(pos, pos + 2) === '/>') break;

      if (src[pos] === '{' && src.slice(pos + 1).trimStart().startsWith('...')) {
        pos++;
        skipSpaces();
        pos += 3;
        const expr = parseBracedExpr();
        props.push(`...(${expr})`);
        continue;
      }

      const attrMatch = src.slice(pos).match(/^[A-Za-z0-9_-]+/);
      if (!attrMatch) {
        pos++;
        continue;
      }
      const attrName = attrMatch[0];
      pos += attrName.length;
      skipSpaces();

      let attrVal = 'true';
      if (src[pos] === '=') {
        pos++; // skip "="
        skipSpaces();
        if (src[pos] === '{') {
          attrVal = parseBracedExpr();
        } else if (src[pos] === '"' || src[pos] === "'" || src[pos] === '`') {
          attrVal = parseQuotedString();
        }
      }
      const propKey = attrName === 'class' ? 'className' : attrName;
      props.push(`${JSON.stringify(propKey)}: ${attrVal}`);
    }

    skipSpaces();
    let isSelfClosing = false;
    if (src.slice(pos, pos + 2) === '/>') {
      isSelfClosing = true;
      pos += 2;
    } else if (src[pos] === '>') {
      pos++;
    }

    const propsObj = props.length > 0 ? `{ ${props.join(', ')} }` : 'null';

    if (isSelfClosing) {
      return `React.createElement(${tagExpr}, ${propsObj})`;
    }

    const closingTag = `</${tagName}>`;
    const children = parseChildren(closingTag);
    if (children.length > 0) {
      return `React.createElement(${tagExpr}, ${propsObj}, ${children.join(', ')})`;
    } else {
      return `React.createElement(${tagExpr}, ${propsObj})`;
    }
  }

  let out = '';
  while (pos < len) {
    if (src[pos] === '<' && (src.slice(pos, pos + 2) === '<>' || /^[A-Za-z0-9_.]/.test(src[pos + 1] || ''))) {
      const before = src.slice(Math.max(0, pos - 30), pos).trim();
      if (/return$|[=(:,[?]|\b(?:case|default)\b|=>$/.test(before) || before === '') {
        const node = transformNode();
        if (node) {
          out += node;
          continue;
        }
      }
    }
    out += src[pos]!;
    pos++;
  }
  return out;
}

/**
 * Builds the standalone sandbox HTML with embedded React 18, Tailwind styles,
 * Lucide icon proxies, error boundary, and the transpiled component.
 */
export function buildComponentSandboxHtml(
  artifact: ActiveArtifact,
  content: string,
  themeStyles: string
): string {
  const { js, mainComponentName, error } = transpileComponentCode(content);

  const tailwindUtilities = `
    /* Reset & Base */
    *, ::before, ::after { box-sizing: border-box; border-width: 0; border-style: solid; border-color: var(--border, #333); }
    html, body { height: 100%; margin: 0; padding: 16px; font-family: var(--font-sans, system-ui, sans-serif); background: var(--bg, #18181b); color: var(--text, #f4f4f5); }
    #root { display: flex; flex-direction: column; min-height: 100%; }

    /* Flexbox & Grid */
    .flex { display: flex; }
    .inline-flex { display: inline-flex; }
    .grid { display: grid; }
    .hidden { display: none; }
    .block { display: block; }
    .inline-block { display: inline-block; }
    .flex-col { flex-direction: column; }
    .flex-row { flex-direction: row; }
    .flex-wrap { flex-wrap: wrap; }
    .items-center { align-items: center; }
    .items-start { align-items: flex-start; }
    .items-end { align-items: flex-end; }
    .justify-center { justify-content: center; }
    .justify-between { justify-content: space-between; }
    .justify-start { justify-content: flex-start; }
    .justify-end { justify-content: flex-end; }
    .gap-1 { gap: 0.25rem; }
    .gap-2 { gap: 0.5rem; }
    .gap-3 { gap: 0.75rem; }
    .gap-4 { gap: 1rem; }
    .gap-6 { gap: 1.5rem; }
    .gap-8 { gap: 2rem; }
    .grid-cols-1 { grid-template-columns: repeat(1, minmax(0, 1fr)); }
    .grid-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .grid-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .grid-cols-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }

    /* Spacing */
    .p-1 { padding: 0.25rem; }
    .p-2 { padding: 0.5rem; }
    .p-3 { padding: 0.75rem; }
    .p-4 { padding: 1rem; }
    .p-5 { padding: 1.25rem; }
    .p-6 { padding: 1.5rem; }
    .p-8 { padding: 2rem; }
    .px-2 { padding-left: 0.5rem; padding-right: 0.5rem; }
    .px-3 { padding-left: 0.75rem; padding-right: 0.75rem; }
    .px-4 { padding-left: 1rem; padding-right: 1rem; }
    .px-6 { padding-left: 1.5rem; padding-right: 1.5rem; }
    .py-1 { padding-top: 0.25rem; padding-bottom: 0.25rem; }
    .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
    .py-3 { padding-top: 0.75rem; padding-bottom: 0.75rem; }
    .py-4 { padding-top: 1rem; padding-bottom: 1rem; }
    .m-1 { margin: 0.25rem; }
    .m-2 { margin: 0.5rem; }
    .m-4 { margin: 1rem; }
    .mb-1 { margin-bottom: 0.25rem; }
    .mb-2 { margin-bottom: 0.5rem; }
    .mb-3 { margin-bottom: 0.75rem; }
    .mb-4 { margin-bottom: 1rem; }
    .mb-6 { margin-bottom: 1.5rem; }
    .mt-1 { margin-top: 0.25rem; }
    .mt-2 { margin-top: 0.5rem; }
    .mt-4 { margin-top: 1rem; }
    .mx-auto { margin-left: auto; margin-right: auto; }

    /* Sizing */
    .w-full { width: 100%; }
    .w-auto { width: auto; }
    .h-full { height: 100%; }
    .w-4 { width: 1rem; }
    .h-4 { height: 1rem; }
    .w-5 { width: 1.25rem; }
    .h-5 { height: 1.25rem; }
    .w-6 { width: 1.5rem; }
    .h-6 { height: 1.5rem; }
    .w-8 { width: 2rem; }
    .h-8 { height: 2rem; }
    .max-w-xs { max-width: 20rem; }
    .max-w-sm { max-width: 24rem; }
    .max-w-md { max-width: 28rem; }
    .max-w-lg { max-width: 32rem; }
    .max-w-xl { max-width: 36rem; }
    .max-w-2xl { max-width: 42rem; }
    .max-w-4xl { max-width: 56rem; }

    /* Typography */
    .text-xs { font-size: 0.75rem; line-height: 1rem; }
    .text-sm { font-size: 0.875rem; line-height: 1.25rem; }
    .text-base { font-size: 1rem; line-height: 1.5rem; }
    .text-lg { font-size: 1.125rem; line-height: 1.75rem; }
    .text-xl { font-size: 1.25rem; line-height: 1.75rem; }
    .text-2xl { font-size: 1.5rem; line-height: 2rem; }
    .text-3xl { font-size: 1.875rem; line-height: 2.25rem; }
    .font-normal { font-weight: 400; }
    .font-medium { font-weight: 500; }
    .font-semibold { font-weight: 600; }
    .font-bold { font-weight: 700; }
    .text-center { text-align: center; }
    .text-left { text-align: left; }
    .text-right { text-align: right; }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    /* Borders & Rounding */
    .border { border-width: 1px; }
    .border-2 { border-width: 2px; }
    .border-t { border-top-width: 1px; }
    .border-b { border-bottom-width: 1px; }
    .rounded-sm { border-radius: 0.125rem; }
    .rounded { border-radius: 0.25rem; }
    .rounded-md { border-radius: 0.375rem; }
    .rounded-lg { border-radius: 0.5rem; }
    .rounded-xl { border-radius: 0.75rem; }
    .rounded-2xl { border-radius: 1rem; }
    .rounded-full { border-radius: 9999px; }

    /* Colors mapped to clean theme variables */
    .bg-white { background-color: #ffffff; color: #18181b; }
    .bg-slate-50 { background-color: #f8fafc; }
    .bg-slate-100 { background-color: #f1f5f9; }
    .bg-slate-800 { background-color: #1e293b; }
    .bg-slate-900 { background-color: #0f172a; }
    .bg-zinc-800 { background-color: #27272a; }
    .bg-zinc-900 { background-color: #18181b; }
    .bg-blue-500 { background-color: #3b82f6; }
    .bg-blue-600 { background-color: #2563eb; }
    .bg-emerald-500 { background-color: #10b981; }
    .bg-rose-500 { background-color: #f43f5e; }
    .bg-amber-500 { background-color: #f59e0b; }
    .text-white { color: #ffffff; }
    .text-slate-200 { color: #e2e8f0; }
    .text-slate-300 { color: #cbd5e1; }
    .text-slate-400 { color: #94a3b8; }
    .text-slate-500 { color: #64748b; }
    .text-slate-700 { color: #334155; }
    .text-slate-900 { color: #0f172a; }
    .text-blue-500 { color: #3b82f6; }
    .text-emerald-500 { color: #10b981; }
    .text-rose-500 { color: #f43f5e; }
    .text-amber-500 { color: #f59e0b; }

    /* Praxis Component Styles */
    .card {
      background: var(--bg-elevated, #262625);
      border: 1px solid var(--border, #3d3d3d);
      border-radius: 8px;
      padding: 16px;
      color: var(--text, #f0f0f2);
    }
    button {
      cursor: pointer;
      font-family: inherit;
    }
  `;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${artifact.name}</title>
  <style>
    ${themeStyles}
    ${tailwindUtilities}
  </style>
  <script>
    ${reactUmd}
  </script>
  <script>
    ${reactDomUmd}
  </script>
</head>
<body>
  <div id="root"></div>
  <script>
    // Security handlers
    document.addEventListener('click', function(e) {
      var target = e.target;
      var link = target instanceof Element ? target.closest('a') : null;
      if (link && !link.getAttribute('href')?.startsWith('#')) {
        e.preventDefault();
      }
    }, true);
    document.addEventListener('submit', function(e) {
      e.preventDefault();
    }, true);

    // Standard hooks & Globals
    const { useState, useEffect, useRef, useMemo, useCallback, useContext, useReducer, createContext } = React;

    // Lucide Icon Proxy: renders an SVG representation for any imported lucide icon
    const LucideProxy = new Proxy({}, {
      get: function(target, prop) {
        return function DynamicLucideIcon(props) {
          const size = props?.size || 18;
          const className = props?.className || '';
          return React.createElement('svg', Object.assign({
            width: size,
            height: size,
            viewBox: '0 0 24 24',
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
            className: 'lucide-icon ' + className,
            'aria-hidden': 'true'
          }, props || {}),
            React.createElement('circle', { cx: 12, cy: 12, r: 9, strokeOpacity: 0.4 }),
            React.createElement('text', {
              x: 12,
              y: 15,
              fontSize: 8,
              textAnchor: 'middle',
              fill: 'currentColor',
              stroke: 'none',
              fontFamily: 'monospace'
            }, String(prop).slice(0, 3).toUpperCase())
          );
        };
      }
    });
    window.Lucide = LucideProxy;
    window.LucideReact = LucideProxy;

    // Module mock for require
    window.require = function(mod) {
      if (mod === 'react') return window.React;
      if (mod === 'react-dom' || mod === 'react-dom/client') return window.ReactDOM;
      if (mod === 'lucide-react') return LucideProxy;
      return {};
    };

    // Error Boundary Component
    class ErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { hasError: false, error: null };
      }
      static getDerivedStateFromError(error) {
        return { hasError: true, error: error };
      }
      componentDidCatch(error, info) {
        console.error("Component error:", error, info);
      }
      render() {
        if (this.state.hasError) {
          return React.createElement('div', {
            style: {
              padding: '16px',
              margin: '16px 0',
              borderRadius: '8px',
              background: 'color-mix(in srgb, var(--accent, #e06c43) 15%, var(--bg-elevated, #262625))',
              border: '1px solid var(--accent, #e06c43)',
              color: 'var(--text, #f0f0f2)',
              fontFamily: 'var(--font-mono, monospace)',
              fontSize: '13px'
            }
          },
            React.createElement('h3', { style: { margin: '0 0 8px', fontSize: '14px', color: 'var(--accent, #e06c43)' } }, 'Component Runtime Error'),
            React.createElement('pre', { style: { whiteSpace: 'pre-wrap', margin: 0 } }, this.state.error?.message || String(this.state.error))
          );
        }
        return this.props.children;
      }
    }

    ${error ? `
      console.error(${JSON.stringify(error)});
      var errBox = document.createElement('div');
      errBox.id = 'praxis-artifact-error';
      errBox.style.cssText = 'padding:16px;background:#3b1212;border:1px solid #e06c43;color:#fff;border-radius:6px;font-family:monospace;font-size:12px;white-space:pre-wrap;';
      errBox.textContent = 'Transpilation Error:\\n' + ${JSON.stringify(error)};
      document.body.prepend(errBox);
    ` : `
      try {
        ${js}

        var ComponentToMount = ${mainComponentName ? mainComponentName : 'null'} ||
          (typeof MetricsCard !== 'undefined' ? MetricsCard : null) ||
          (typeof App !== 'undefined' ? App : null) ||
          (typeof Dashboard !== 'undefined' ? Dashboard : null) ||
          (typeof Component !== 'undefined' ? Component : null);

        if (ComponentToMount) {
          var root = ReactDOM.createRoot(document.getElementById('root'));
          root.render(React.createElement(ErrorBoundary, null, React.createElement(ComponentToMount)));
        } else {
          var notice = document.createElement('div');
          notice.style.padding = '20px';
          notice.textContent = 'Artifact evaluated, but no React component function was found to render.';
          document.getElementById('root').appendChild(notice);
        }
      } catch (err) {
        console.error("Evaluation error:", err);
        var errBox = document.createElement('div');
        errBox.id = 'praxis-artifact-error';
        errBox.style.cssText = 'padding:16px;background:#3b1212;border:1px solid #e06c43;color:#fff;border-radius:6px;font-family:monospace;font-size:12px;white-space:pre-wrap;';
        errBox.textContent = 'Evaluation Error:\\n' + err.message + (err.stack ? '\\n\\n' + err.stack : '');
        document.body.prepend(errBox);
      }
    `}
  </script>
</body>
</html>`;
}
