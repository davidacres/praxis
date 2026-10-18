import { useEffect, useMemo, useRef, useState } from 'react';
import type { CodeIntelligenceRequest, CodeIntelligenceResponse } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { ChipSelect } from '../ui/ChipSelect';
import './codeSearchDialog.css';

type ObjectValue = Record<string, unknown>;
function record(value: unknown): ObjectValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : {};
}
/**
 * The last `segments` parts of a qualified name, without its parameter list: C# names
 * carry dotted parameter types (`Repo.Map(Maze.Models.User)`), so splitting on '.' alone
 * would show `User)`. Relation rows use two parts (`AuthController.Login`).
 */
// A file's top-level statements are indexed as one symbol named after the file.
const TOP_LEVEL_ENTRY = ' [synthetic top-level entry]';

function shortSymbolName(qualifiedName: string, segments = 1): string {
  if (qualifiedName.endsWith(TOP_LEVEL_ENTRY))
    return `${qualifiedName.slice(0, -TOP_LEVEL_ENTRY.length).split('/').pop()} (top level)`;
  const parts = qualifiedName.replace(/\(.*\)$/, '').split('.').filter(Boolean);
  return parts.slice(-segments).join('.') || qualifiedName;
}

function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export interface CodeSearchSymbol {
  symbolId: string;
  qualifiedName: string;
  signature: string;
  kind: string;
  resolution?: string;
  declarations?: string[];
  external?: boolean;
}

export interface CodeSearchMatch {
  symbol: CodeSearchSymbol;
  score: number;
  ranks?: Record<string, number>;
  reasons?: string[];
  evidenceIds?: string[];
}

export interface CodeSearchEvidence {
  id: string;
  path?: string;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

export interface CodeSearchDialogProps {
  open: boolean;
  onClose: () => void;
  initialQuery?: string;
  initialWorkingDirectory?: string;
}

// The service's default budget (4,000 tokens) cannot hold 30 results with their evidence and
// silently shortens the page; ask for what the rest of the app uses.
const RESPONSE_BUDGET = 8000;

const REASON_LABELS: Record<string, string> = { exact: 'Exact', lexical: 'Keyword', vector: 'Semantic', alias: 'Alias', graph: 'Related' };

/** Why a result matched, in the service's order: "Keyword · Semantic". */
function matchReasons(reasons: string[] | undefined): string {
  return [...new Set((reasons ?? []).map(reason => REASON_LABELS[reason] ?? reason))].join(' · ');
}

export function CodeSearchDialog({
  open,
  onClose,
  initialQuery = '',
  initialWorkingDirectory
}: CodeSearchDialogProps) {
  const [repositories, setRepositories] = useState<Array<{ id: string; root: string; state: string }>>([]);
  const [repositoryId, setRepositoryId] = useState('');
  const [query, setQuery] = useState(initialQuery);
  const [mode, setMode] = useState<'hybrid' | 'lexical' | 'vector'>('hybrid');
  const [busy, setBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [error, setError] = useState('');
  const [matches, setMatches] = useState<CodeSearchMatch[]>([]);
  const [evidenceMap, setEvidenceMap] = useState<Map<string, CodeSearchEvidence>>(new Map());
  const [selectedSymbolId, setSelectedSymbolId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'source' | 'callers' | 'callees' | 'explain'>('source');
  const [toast, setToast] = useState('');
  // What the service says about this answer: a fallback to keywords, or semantic coverage
  // still building. Without it, Hybrid with no model looks exactly like a working Hybrid.
  const [notices, setNotices] = useState<string[]>([]);
  // A first model build: nothing semantic can be searched until every symbol has a vector,
  // so say how far it has got and search again once it is active.
  const [modelBuilding, setModelBuilding] = useState(false);
  const searchedQuery = useRef('');

  // Per-symbol detail caches
  const [sourceCache, setSourceCache] = useState<Record<string, { text: string; path?: string; lineStart?: number }>>({});
  const [callersCache, setCallersCache] = useState<Record<string, Array<{ edgeId: string; symbolId: string; qualifiedName?: string; path?: string; line?: number }>>>({});
  const [calleesCache, setCalleesCache] = useState<Record<string, Array<{ edgeId: string; symbolId: string; qualifiedName?: string; path?: string; line?: number }>>>({});
  const [explainCache, setExplainCache] = useState<Record<string, { desc: string; facts: string[] }>>({});

  const inputRef = useRef<HTMLInputElement>(null);
  const toastTimerRef = useRef<number>();

  const showToast = (message: string) => {
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => setToast(''), 2500);
  };

  async function call(request: CodeIntelligenceRequest): Promise<CodeIntelligenceResponse> {
    if (!window.praxis?.ai?.codeIntelligence) {
      throw new Error('Code intelligence is not supported in this runtime.');
    }
    const result = await window.praxis.ai.codeIntelligence(request);
    if (result.error) throw new Error(`${result.error.code}: ${result.error.message}`);
    return result;
  }

  // Load repositories on mount
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function initRepos() {
      try {
        const listRes = await call({ action: 'list' });
        const list = items(listRes.data).map(v => {
          const r = record(v);
          return { id: String(r.id), root: String(r.root), state: String(r.state) };
        });

        if (cancelled) return;
        setRepositories(list);

        let targetId = '';
        if (initialWorkingDirectory) {
          const matched = list.find(r => r.root === initialWorkingDirectory);
          if (matched) {
            targetId = matched.id;
          } else {
            // Auto-register folder if needed
            try {
              const reg = await call({ action: 'register', root: initialWorkingDirectory });
              const regId = String(record(reg.data).repositoryId || '');
              if (regId) {
                targetId = regId;
                list.push({ id: regId, root: initialWorkingDirectory, state: 'indexing' });
                setRepositories([...list]);
              }
            } catch {
              // fallback to first if register failed
            }
          }
        }

        if (!targetId && list.length > 0) {
          targetId = list[0].id;
        }

        setRepositoryId(targetId);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load repositories');
      }
    }

    void initRepos();
    return () => {
      cancelled = true;
    };
  }, [open, initialWorkingDirectory]);

  // Focus search input when open
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // A mode change answers the same question again in the new mode; otherwise the old
  // results stay on screen under the new mode's name.
  const modeShown = useRef(mode);
  useEffect(() => {
    if (modeShown.current === mode) return;
    modeShown.current = mode;
    if (searchedQuery.current) void runSearch(searchedQuery.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /** Progress of a model still on its first build, or undefined when none is building. */
  async function buildingModel(): Promise<{ current: number; eligible: number } | undefined> {
    try {
      const status = await call({ action: 'query', tool: 'get_index_status', arguments: { repositoryId, responseBudgetTokens: RESPONSE_BUDGET } });
      const models = items(record(status.data).models).map(record);
      if (models.some(model => model.state === 'active')) return undefined;
      const building = models.find(model => model.state === 'building');
      if (!building) return undefined;
      const coverage = record(building.coverage);
      return { current: Number(coverage.current ?? 0), eligible: Number(coverage.eligible ?? 0) };
    } catch { return undefined; }
  }
  const buildingNotice = (progress: { current: number; eligible: number }, fallback: boolean) =>
    `Semantic index is building: ${progress.current.toLocaleString()} of ${progress.eligible.toLocaleString()} symbols embedded. ` +
    (fallback ? 'Keyword results are shown until it finishes.' : 'Semantic search starts when it finishes.');

  useEffect(() => {
    if (!open || !modelBuilding) return;
    const timer = window.setInterval(() => {
      void buildingModel().then(progress => {
        if (progress) setNotices(current => current.map(notice => notice.startsWith('Semantic index is building') ? buildingNotice(progress, mode === 'hybrid') : notice));
        else if (searchedQuery.current) void runSearch(searchedQuery.current);
      });
    }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, modelBuilding, mode, repositoryId]);

  // Perform search
  const runSearch = async (targetQuery?: string) => {
    const q = (targetQuery ?? query).trim();
    if (!q || !repositoryId) return;

    setBusy(true);
    setError('');
    setNotices([]);
    setModelBuilding(false);
    searchedQuery.current = q;
    try {
      const res = await call({
        action: 'query',
        tool: 'search_code',
        arguments: { repositoryId, query: q, mode, limit: 30, responseBudgetTokens: RESPONSE_BUDGET }
      });
      const data = record(res.data);
      const eligible = Number(data.eligibleSymbolCount ?? 0);
      const covered = Number(data.vectorCoveredSymbolCount ?? 0);
      const warnings = items(res.warnings).map(record);
      // Without a model nothing is building; the fallback warning already says so.
      const modelUnavailable = warnings.some(warning => warning.code === 'MODEL_UNAVAILABLE');
      const progress = modelUnavailable ? await buildingModel() : undefined;
      setModelBuilding(Boolean(progress));
      setNotices([
        ...warnings.map(warning => progress && warning.code === 'MODEL_UNAVAILABLE' ? buildingNotice(progress, true) : String(warning.message ?? '')).filter(Boolean),
        ...(mode !== 'lexical' && !modelUnavailable && eligible > 0 && covered < eligible
          ? [`Semantic index is still building: ${covered} of ${eligible} symbols can be found by meaning so far.`]
          : [])
      ]);

      // Parse evidence map
      const evMap = new Map<string, CodeSearchEvidence>();
      const evItems = items(res.evidence);
      for (const rawEv of evItems) {
        const ev = record(rawEv);
        const id = String(ev.id ?? '');
        if (id) {
          const rng = record(ev.range);
          const start = record(rng.start);
          const end = record(rng.end);
          evMap.set(id, {
            id,
            path: typeof ev.path === 'string' ? ev.path : undefined,
            range: {
              start: { line: Number(start.line ?? 0), character: Number(start.character ?? 0) },
              end: { line: Number(end.line ?? 0), character: Number(end.character ?? 0) }
            }
          });
        }
      }
      setEvidenceMap(evMap);

      const rawMatches = items(record(res.data).matches);
      const parsed: CodeSearchMatch[] = rawMatches.map(m => {
        const r = record(m);
        const sym = record(r.symbol);
        return {
          symbol: {
            symbolId: String(sym.symbolId ?? ''),
            qualifiedName: String(sym.qualifiedName ?? ''),
            signature: sym.signature === TOP_LEVEL_ENTRY.trim() ? 'Top-level code' : String(sym.signature ?? ''),
            kind: String(sym.kind ?? 'symbol'),
            resolution: typeof sym.resolution === 'string' ? sym.resolution : undefined,
            declarations: items(sym.declarations).map(String),
            external: Boolean(sym.external)
          },
          score: Number(r.score ?? 0),
          ranks: record(r.ranks) as Record<string, number>,
          reasons: items(r.reasons).map(String),
          evidenceIds: items(r.evidenceIds).map(String)
        };
      });

      setMatches(parsed);
      if (parsed.length > 0) {
        setSelectedSymbolId(parsed[0].symbol.symbolId);
      } else {
        setSelectedSymbolId('');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Search failed.';
      const progress = message.startsWith('MODEL_UNAVAILABLE') ? await buildingModel() : undefined;
      if (progress) {
        setMatches([]);
        setSelectedSymbolId('');
        setModelBuilding(true);
        setNotices([buildingNotice(progress, false)]);
      } else setError(message);
    } finally {
      setBusy(false);
    }
  };

  // Trigger search on mount if initialQuery provided and repo is ready
  useEffect(() => {
    if (repositoryId && initialQuery) {
      void runSearch(initialQuery);
    }
  }, [repositoryId]);

  const selectedMatch = useMemo(
    () => matches.find(m => m.symbol.symbolId === selectedSymbolId) ?? matches[0],
    [matches, selectedSymbolId]
  );

  // Fetch details for selected symbol
  useEffect(() => {
    if (!selectedMatch || !repositoryId) return;
    const symId = selectedMatch.symbol.symbolId;
    if (!symId) return;

    let cancelled = false;

    async function loadDetail() {
      setDetailBusy(true);
      try {
        if (activeTab === 'source' && !sourceCache[symId]) {
          if (selectedMatch?.symbol.external) {
            setSourceCache(prev => ({
              ...prev,
              [symId]: { text: '// Metadata or external symbol; no source available in repository.' }
            }));
          } else {
            const res = await call({
              action: 'query',
              tool: 'get_source',
              arguments: { repositoryId, symbolId: symId, maxLines: 120, responseBudgetTokens: RESPONSE_BUDGET }
            });
            const frags = items(record(res.data).fragments);
            const firstFrag = record(frags[0]);
            const text = String(firstFrag.text ?? '');
            const rng = record(firstFrag.range);
            const startLine = Number(record(rng.start).line ?? 1);

            // Find path from evidence
            let foundPath: string | undefined;
            const evItems = items(res.evidence);
            for (const item of evItems) {
              const ev = record(item);
              if (typeof ev.path === 'string') {
                foundPath = ev.path;
                break;
              }
            }

            if (!cancelled) {
              setSourceCache(prev => ({
                ...prev,
                [symId]: { text, path: foundPath, lineStart: startLine }
              }));
            }
          }
        } else if (activeTab === 'callers' && !callersCache[symId]) {
          const res = await call({
            action: 'query',
            tool: 'get_callers',
            arguments: { repositoryId, symbolId: symId, limit: 30, responseBudgetTokens: RESPONSE_BUDGET }
          });
          const rawItems = items(record(res.data).items);
          const evItems = items(res.evidence);
          const evMap = new Map<string, { path?: string; line?: number }>();
          for (const ev of evItems) {
            const rec = record(ev);
            const id = String(rec.id ?? '');
            const rng = record(rec.range);
            const line = Number(record(rng.start).line ?? 0);
            evMap.set(id, { path: typeof rec.path === 'string' ? rec.path : undefined, line });
          }

          const parsedCallers = rawItems.map(item => {
            const r = record(item);
            const srcId = String(r.sourceSymbolId ?? '');
            const evIds = items(r.evidenceIds).map(String);
            const ev = evIds[0] ? evMap.get(evIds[0]) : undefined;
            // The service names the far end of each call; older services sent only its ID.
            const farEnd = record(r.symbol).qualifiedName;
            return {
              edgeId: String(r.edgeId ?? ''),
              symbolId: srcId,
              qualifiedName: typeof farEnd === 'string' && farEnd ? farEnd : undefined,
              path: ev?.path,
              line: ev?.line
            };
          });

          if (!cancelled) {
            setCallersCache(prev => ({
              ...prev,
              [symId]: parsedCallers
            }));
          }
        } else if (activeTab === 'callees' && !calleesCache[symId]) {
          const res = await call({
            action: 'query',
            tool: 'get_callees',
            arguments: { repositoryId, symbolId: symId, limit: 30, responseBudgetTokens: RESPONSE_BUDGET }
          });
          const rawItems = items(record(res.data).items);
          const evItems = items(res.evidence);
          const evMap = new Map<string, { path?: string; line?: number }>();
          for (const ev of evItems) {
            const rec = record(ev);
            const id = String(rec.id ?? '');
            const rng = record(rec.range);
            const line = Number(record(rng.start).line ?? 0);
            evMap.set(id, { path: typeof rec.path === 'string' ? rec.path : undefined, line });
          }

          const parsedCallees = rawItems.map(item => {
            const r = record(item);
            const tgtId = String(r.targetSymbolId ?? '');
            const evIds = items(r.evidenceIds).map(String);
            const ev = evIds[0] ? evMap.get(evIds[0]) : undefined;
            // The service names the far end of each call; older services sent only its ID.
            const farEnd = record(r.symbol).qualifiedName;
            return {
              edgeId: String(r.edgeId ?? ''),
              symbolId: tgtId,
              qualifiedName: typeof farEnd === 'string' && farEnd ? farEnd : undefined,
              path: ev?.path,
              line: ev?.line
            };
          });

          if (!cancelled) {
            setCalleesCache(prev => ({
              ...prev,
              [symId]: parsedCallees
            }));
          }
        } else if (activeTab === 'explain' && !explainCache[symId]) {
          const res = await call({
            action: 'query',
            tool: 'explain_symbol',
            arguments: { repositoryId, symbolId: symId, responseBudgetTokens: RESPONSE_BUDGET }
          });
          const data = record(res.data);
          const desc = String(record(data.description).text ?? '');
          const rawFacts = items(data.facts);
          const facts = rawFacts.map(f => String(record(f).text ?? '')).filter(Boolean);

          if (!cancelled) {
            setExplainCache(prev => ({
              ...prev,
              [symId]: { desc, facts }
            }));
          }
        }
      } catch (err) {
        // Soft fail on detail tabs
      } finally {
        if (!cancelled) setDetailBusy(false);
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [selectedMatch, activeTab, repositoryId]);

  // Arrow key navigation through matches
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = matches.findIndex(m => m.symbol.symbolId === selectedSymbolId);
      if (idx >= 0 && idx < matches.length - 1) {
        setSelectedSymbolId(matches[idx + 1].symbol.symbolId);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const idx = matches.findIndex(m => m.symbol.symbolId === selectedSymbolId);
      if (idx > 0) {
        setSelectedSymbolId(matches[idx - 1].symbol.symbolId);
      }
    }
  };

  const getMatchLocation = (match: CodeSearchMatch) => {
    for (const evId of [...(match.evidenceIds ?? []), ...(match.symbol.declarations ?? [])]) {
      const ev = evidenceMap.get(evId);
      if (ev?.path) {
        return `${ev.path}:${(ev.range?.start.line ?? 0) + 1}`;
      }
    }
    return match.symbol.external ? 'external metadata' : undefined;
  };

  const currentSource = selectedSymbolId ? sourceCache[selectedSymbolId] : undefined;
  const currentCallers = selectedSymbolId ? callersCache[selectedSymbolId] : undefined;
  const currentCallees = selectedSymbolId ? calleesCache[selectedSymbolId] : undefined;
  const currentExplain = selectedSymbolId ? explainCache[selectedSymbolId] : undefined;

  const copySymbolName = () => {
    if (!selectedMatch) return;
    void navigator.clipboard.writeText(selectedMatch.symbol.qualifiedName);
    showToast('Copied symbol name');
  };

  const copySourceCode = () => {
    if (!currentSource?.text) return;
    void navigator.clipboard.writeText(currentSource.text);
    showToast('Copied source snippet');
  };

  const copyLocation = () => {
    if (!selectedMatch) return;
    const loc = getMatchLocation(selectedMatch);
    if (loc) {
      void navigator.clipboard.writeText(loc);
      showToast('Copied file location');
    }
  };

  const insertIntoComposer = () => {
    if (!selectedMatch) return;
    const loc = getMatchLocation(selectedMatch) ?? '';
    const codeSnippet = currentSource?.text
      ? `\`\`\`\n// ${selectedMatch.symbol.qualifiedName}${loc ? ` (${loc})` : ''}\n${currentSource.text}\n\`\`\``
      : `\`${selectedMatch.symbol.qualifiedName}\`${loc ? ` (${loc})` : ''}`;

    window.dispatchEvent(
      new CustomEvent('praxis:composer-insert', {
        detail: { text: codeSnippet }
      })
    );
    void navigator.clipboard.writeText(codeSnippet);
    showToast('Inserted into session & copied to clipboard');
  };

  if (!open) return null;

  return (
    <div
      className="code-search-overlay"
      data-testid="code-search-dialog"
      onClick={onClose}
    >
      <section
        className="modal-card code-search-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="code-search-title"
        onClick={e => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <header className="code-search-header">
          <div className="code-search-header-title">
            <Icon name="search" size={16} />
            <h3 id="code-search-title">Code &amp; Symbol Search</h3>
            <span className="code-search-badge">⌘⇧F</span>
          </div>
          <button
            className="icon-btn icon-btn-sm"
            type="button"
            aria-label="Close code search"
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </header>

        <form
          className="code-search-toolbar"
          onSubmit={e => {
            e.preventDefault();
            void runSearch();
          }}
        >
          <div className="code-search-input-wrap">
            <span className="code-search-input-icon">
              <Icon name="search" size={14} />
            </span>
            <input
              ref={inputRef}
              className="code-search-input"
              data-testid="code-search-input"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search symbols, methods, types, or descriptions…"
            />
          </div>

          <div className="code-search-chip-group">
            <ChipSelect
              ariaLabel="Search mode"
              value={mode}
              onChange={val => setMode(val as 'hybrid' | 'lexical' | 'vector')}
              options={[
                { value: 'hybrid', label: 'Hybrid', meta: 'Keywords + semantic vectors' },
                { value: 'lexical', label: 'Keyword', meta: 'Names and text only' },
                { value: 'vector', label: 'Semantic', meta: 'Meaning only (local model)' }
              ]}
            />

            <ChipSelect
              ariaLabel="Repository"
              value={repositoryId}
              disabled={repositories.length === 0}
              onChange={setRepositoryId}
              options={repositories.map(r => ({
                value: r.id,
                label: r.root.split('/').pop() || r.root,
                meta: r.root
              }))}
              placeholder="No repository"
            />

            <button
              className="btn btn-sm btn-primary"
              data-testid="code-search-submit-btn"
              type="submit"
              disabled={busy || !query.trim() || !repositoryId}
            >
              {busy ? 'Searching…' : 'Search'}
            </button>
          </div>
        </form>

        <div className="code-search-layout">
          {/* Left Pane: Results list */}
          <div className="code-search-results-pane">
            <div className="code-search-results-header">
              <span>{busy ? 'Searching…' : `${matches.length} matches`}</span>
              {matches.length > 0 && <span>↑↓ to navigate</span>}
            </div>

            {error && <div className="error-banner" style={{ margin: 8 }}>{error}</div>}
            {notices.length > 0 && (
              <div className="code-search-notice" role="status" data-testid="code-search-notice">
                {notices.map(notice => <div key={notice}>{notice}</div>)}
              </div>
            )}

            <ul className="code-search-results-list" data-testid="code-search-results-list">
              {matches.map(m => {
                const isSelected = m.symbol.symbolId === (selectedMatch?.symbol.symbolId ?? '');
                const loc = getMatchLocation(m);
                return (
                  <li key={m.symbol.symbolId}>
                    <button
                      type="button"
                      className={`code-search-item${isSelected ? ' active' : ''}`}
                      data-testid={`code-search-item-${m.symbol.symbolId}`}
                      onClick={() => setSelectedSymbolId(m.symbol.symbolId)}
                    >
                      <div className="code-search-item-top">
                        <span className="code-search-item-name" title={m.symbol.qualifiedName}>
                          {shortSymbolName(m.symbol.qualifiedName)}
                        </span>
                        <span className="code-search-kind-badge">{m.symbol.kind}</span>
                      </div>
                      {/* Every row has all three lines, empty or not, so rows share one height. */}
                      <div className="code-search-item-signature" title={m.symbol.signature}>
                        {m.symbol.signature || '\u00a0'}
                      </div>
                      <div className="code-search-item-meta">
                        <span className="code-search-item-path" title={loc}>{loc ?? '\u00a0'}</span>
                        {matchReasons(m.reasons) && <span className="code-search-item-reasons">{matchReasons(m.reasons)}</span>}
                      </div>
                    </button>
                  </li>
                );
              })}

              {!busy && matches.length === 0 && !(modelBuilding && mode === 'vector') && (
                <div className="code-search-empty-state">
                  <Icon name="search" size={24} />
                  <span>{query.trim() ? 'No symbols or code matches found.' : 'Enter a search term to find code and symbols.'}</span>
                </div>
              )}
            </ul>
          </div>

          {/* Right Pane: Detail & usages */}
          <div className="code-search-detail-pane">
            {selectedMatch ? (
              <>
                <div className="code-search-detail-header">
                  <div className="code-search-detail-title-row">
                    <div className="code-search-detail-title">
                      <h4>{selectedMatch.symbol.qualifiedName}</h4>
                      <span className="code-search-kind-badge">{selectedMatch.symbol.kind}</span>
                    </div>
                  </div>
                  <div className="code-search-detail-sig">{selectedMatch.symbol.signature}</div>
                  {getMatchLocation(selectedMatch) && (
                    <div className="code-search-detail-meta">{getMatchLocation(selectedMatch)}</div>
                  )}
                </div>

                <div className="code-search-tabs">
                  <button
                    type="button"
                    className={`code-search-tab${activeTab === 'source' ? ' active' : ''}`}
                    data-testid="code-search-tab-source"
                    onClick={() => setActiveTab('source')}
                  >
                    <Icon name="file" size={13} />
                    <span>Source</span>
                  </button>
                  <button
                    type="button"
                    className={`code-search-tab${activeTab === 'callers' ? ' active' : ''}`}
                    data-testid="code-search-tab-callers"
                    onClick={() => setActiveTab('callers')}
                  >
                    <Icon name="split-horizontal" size={13} />
                    <span>Usages (Callers)</span>
                    {currentCallers && <span className="code-search-tab-count">{currentCallers.length}</span>}
                  </button>
                  <button
                    type="button"
                    className={`code-search-tab${activeTab === 'callees' ? ' active' : ''}`}
                    data-testid="code-search-tab-callees"
                    onClick={() => setActiveTab('callees')}
                  >
                    <Icon name="chevron-right" size={13} />
                    <span>Callees</span>
                    {currentCallees && <span className="code-search-tab-count">{currentCallees.length}</span>}
                  </button>
                  <button
                    type="button"
                    className={`code-search-tab${activeTab === 'explain' ? ' active' : ''}`}
                    data-testid="code-search-tab-explain"
                    onClick={() => setActiveTab('explain')}
                  >
                    <Icon name="lightbulb" size={13} />
                    <span>Explanation</span>
                  </button>
                </div>

                <div className="code-search-tab-body">
                  {detailBusy && !currentSource && !currentCallers && !currentCallees && !currentExplain && (
                    <div className="code-search-empty-state">Loading details…</div>
                  )}

                  {activeTab === 'source' && (
                    <div>
                      {currentSource?.path && (
                        <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--text-muted)' }}>
                          File: <code>{currentSource.path}</code>
                        </div>
                      )}
                      <pre className="code-search-code-view" data-testid="code-search-source-view">
                        {currentSource?.text || '// No source text available'}
                      </pre>
                    </div>
                  )}

                  {activeTab === 'callers' && (
                    <div>
                      {currentCallers && currentCallers.length > 0 ? (
                        <ul className="code-search-relation-list" data-testid="code-search-callers-list">
                          {currentCallers.map((caller, i) => (
                            <li key={caller.edgeId || i} className="code-search-relation-item">
                              <div className="code-search-relation-header">
                                <span className="code-search-relation-symbol" title={caller.qualifiedName ?? caller.symbolId}>
                                  {caller.qualifiedName ? shortSymbolName(caller.qualifiedName, 2) : caller.symbolId}
                                </span>
                              </div>
                              {caller.path && (
                                <div className="code-search-relation-loc">
                                  {caller.path}:{caller.line ? caller.line + 1 : 1}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="code-search-empty-state">No callers recorded for this symbol.</div>
                      )}
                    </div>
                  )}

                  {activeTab === 'callees' && (
                    <div>
                      {currentCallees && currentCallees.length > 0 ? (
                        <ul className="code-search-relation-list" data-testid="code-search-callees-list">
                          {currentCallees.map((callee, i) => (
                            <li key={callee.edgeId || i} className="code-search-relation-item">
                              <div className="code-search-relation-header">
                                <span className="code-search-relation-symbol" title={callee.qualifiedName ?? callee.symbolId}>
                                  {callee.qualifiedName ? shortSymbolName(callee.qualifiedName, 2) : callee.symbolId}
                                </span>
                              </div>
                              {callee.path && (
                                <div className="code-search-relation-loc">
                                  {callee.path}:{callee.line ? callee.line + 1 : 1}
                                </div>
                              )}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div className="code-search-empty-state">No callees recorded for this symbol.</div>
                      )}
                    </div>
                  )}

                  {activeTab === 'explain' && (
                    <div className="code-search-explain-box" data-testid="code-search-explain-view">
                      {currentExplain?.desc && (
                        <div className="code-search-explain-desc">
                          {currentExplain.desc}
                        </div>
                      )}
                      {currentExplain?.facts && currentExplain.facts.length > 0 && (
                        <ul className="code-search-facts-list">
                          {currentExplain.facts.map((fact, idx) => (
                            <li key={idx} className="code-search-fact-item">
                              {fact}
                            </li>
                          ))}
                        </ul>
                      )}
                      {!currentExplain?.desc && (!currentExplain?.facts || currentExplain.facts.length === 0) && (
                        <div className="code-search-empty-state">No structured explanation available.</div>
                      )}
                    </div>
                  )}
                </div>

                <div className="code-search-detail-footer">
                  <div className="code-search-actions-group">
                    <button
                      className="btn btn-sm"
                      type="button"
                      data-testid="code-search-copy-symbol-btn"
                      onClick={copySymbolName}
                    >
                      <Icon name="copy" size={13} />
                      <span>Copy Symbol</span>
                    </button>
                    <button
                      className="btn btn-sm"
                      type="button"
                      disabled={!currentSource?.text}
                      onClick={copySourceCode}
                    >
                      <Icon name="copy" size={13} />
                      <span>Copy Source</span>
                    </button>
                    {getMatchLocation(selectedMatch) && (
                      <button
                        className="btn btn-sm"
                        type="button"
                        onClick={copyLocation}
                      >
                        <Icon name="copy" size={13} />
                        <span>Copy Location</span>
                      </button>
                    )}
                    <button
                      className="btn btn-sm btn-primary"
                      type="button"
                      data-testid="code-search-insert-btn"
                      onClick={insertIntoComposer}
                    >
                      <Icon name="sparkles" size={13} />
                      <span>Insert into Session</span>
                    </button>
                  </div>

                  {toast && <span className="code-search-toast">{toast}</span>}
                </div>
              </>
            ) : (
              <div className="code-search-empty-state">
                Select a code search result to view source, callers, and details.
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
