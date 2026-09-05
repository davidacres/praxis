import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon, type IconName } from '../ui/Icon';

/**
 * ⌘K navigation. Praxis nests projects → boards → issues → sessions → agents →
 * skills → workflows → runs plus a dialog of settings pages, and every one of
 * those was a mouse trip through the tree. This is one flat, filterable index
 * over state the shell already holds.
 *
 * Navigation only for now — no commands. The static index is passed in; this
 * component owns filtering, keyboard motion, and the overlay. Issues are the
 * one thing the shell doesn't hold in memory (they're paged per board), so
 * they're the one part of the index that's asynchronous: `onSearch` is
 * debounced and race-guarded, and its results are appended under their own
 * group once the static list is scored and sorted.
 */

export interface CommandEntry {
  id: string;
  label: string;
  /** Secondary line, e.g. a project key or a path fragment. */
  hint?: string;
  group: string;
  icon: IconName;
  /** Extra words to match on that are not shown. */
  keywords?: string;
  run: () => void;
}

function score(entry: CommandEntry, query: string): number {
  if (!query) return 1;
  const haystack = `${entry.label} ${entry.hint ?? ''} ${entry.group} ${entry.keywords ?? ''}`.toLowerCase();
  const needle = query.toLowerCase();
  if (haystack.includes(needle)) {
    // Prefer a hit at the start of the label, then anywhere in the label.
    if (entry.label.toLowerCase().startsWith(needle)) return 3;
    if (entry.label.toLowerCase().includes(needle)) return 2;
    return 1;
  }
  // Subsequence match: every character of the query appears in order.
  let i = 0;
  for (const char of haystack) {
    if (char === needle[i]) i += 1;
    if (i === needle.length) return 0.5;
  }
  return 0;
}

export function CommandPalette({
  entries,
  onClose,
  onSearch
}: {
  entries: CommandEntry[];
  onClose: () => void;
  /** Debounced issue search against the connections the shell already holds — see App's `searchIssues`. */
  onSearch?: (query: string) => Promise<CommandEntry[]>;
}) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [asyncResults, setAsyncResults] = useState<CommandEntry[]>([]);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchTokenRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Debounced, race-safe: a stale response (query changed again mid-flight)
  // is dropped by comparing against the token captured when it was issued.
  useEffect(() => {
    const trimmed = query.trim();
    if (!onSearch || trimmed.length < 2) {
      setAsyncResults([]);
      setSearching(false);
      return;
    }
    const token = ++searchTokenRef.current;
    setSearching(true);
    const timer = setTimeout(() => {
      onSearch(trimmed)
        .then(found => {
          if (searchTokenRef.current === token) {
            setAsyncResults(found);
            setSearching(false);
          }
        })
        .catch(() => {
          if (searchTokenRef.current === token) {
            setAsyncResults([]);
            setSearching(false);
          }
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [query, onSearch]);

  const results = useMemo(() => {
    const scored = entries
      .map(entry => ({ entry, s: score(entry, query.trim()) }))
      .filter(row => row.s > 0)
      .sort((a, b) => b.s - a.s);
    const staticResults = scored.map(row => row.entry);
    if (asyncResults.length === 0) return staticResults.slice(0, 40);
    const staticIds = new Set(staticResults.map(entry => entry.id));
    return [...staticResults, ...asyncResults.filter(entry => !staticIds.has(entry.id))].slice(0, 40);
  }, [entries, query, asyncResults]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, results]);

  const choose = (entry: CommandEntry | undefined) => {
    if (!entry) return;
    onClose();
    entry.run();
  };

  // Results carry their group as a heading whenever it changes down the list.
  const rows: Array<{ kind: 'heading'; group: string } | { kind: 'entry'; entry: CommandEntry; index: number }> = [];
  let lastGroup = '';
  results.forEach((entry, index) => {
    if (entry.group !== lastGroup) {
      rows.push({ kind: 'heading', group: entry.group });
      lastGroup = entry.group;
    }
    rows.push({ kind: 'entry', entry, index });
  });

  return (
    <div
      className="modal-overlay command-palette-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Go to"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveIndex(index => Math.min(index + 1, results.length - 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveIndex(index => Math.max(index - 1, 0));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            choose(results[activeIndex]);
          }
        }}
      >
        <div className="command-palette-input">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Go to a project, board, issue, session, agent, workflow, or setting…"
            aria-label="Go to"
            onChange={event => setQuery(event.target.value)}
          />
          <kbd>esc</kbd>
        </div>
        <div className="command-palette-results" ref={listRef} role="listbox">
          {results.length === 0 ? (
            <p className="command-palette-empty">
              {searching ? 'Searching issues…' : <>Nothing matches &ldquo;{query}&rdquo;.</>}
            </p>
          ) : (
            rows.map(row =>
              row.kind === 'heading' ? (
                <div className="command-palette-group" key={`h:${row.group}`}>
                  {row.group}
                </div>
              ) : (
                <button
                  key={row.entry.id}
                  type="button"
                  role="option"
                  aria-selected={row.index === activeIndex}
                  data-active={row.index === activeIndex}
                  className="command-palette-row"
                  onMouseMove={() => setActiveIndex(row.index)}
                  onClick={() => choose(row.entry)}
                >
                  <Icon name={row.entry.icon} size={14} />
                  <span className="command-palette-label">{row.entry.label}</span>
                  {row.entry.hint && <span className="command-palette-hint">{row.entry.hint}</span>}
                </button>
              )
            )
          )}
        </div>
      </div>
    </div>
  );
}
