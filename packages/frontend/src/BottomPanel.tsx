import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export type PanelTab = 'output' | 'terminal';

export interface BottomPanelProps {
  onClose: () => void;
}

interface TabDef {
  id: PanelTab;
  label: string;
}

const TABS: TabDef[] = [
  { id: 'output', label: 'Output' },
  { id: 'terminal', label: 'Terminal' }
];

/**
 * The dockable bottom panel. Laid out against the reference: a borderless tab
 * strip on the left, the active tab marked by an accent underline rather than a
 * frame, and the per-tab action group pushed to the right edge.
 */
/** Client-side cap on rendered lines; the main-side ring buffer holds 500. */
const MAX_RENDERED_LINES = 500;

export function BottomPanel({ onClose }: BottomPanelProps) {
  const [tab, setTab] = useState<PanelTab>('terminal');
  const [logLines, setLogLines] = useState<string[]>([]);
  const outputRef = useRef<HTMLDivElement>(null);

  // Tail the main-process log bus: backfill the ring buffer, then append every
  // pushed line. The panel only exists while visible, so the backlog fetch is
  // what keeps history across open/close.
  useEffect(() => {
    let cancelled = false;
    void window.ticketManager.log
      .getRecent()
      .then(recent => {
        if (!cancelled) {
          setLogLines(recent);
        }
      })
      .catch(error => console.error('Failed to load log output:', error));
    const unsubscribe = window.ticketManager.log.onAppended(line => {
      setLogLines(current => [...current.slice(-(MAX_RENDERED_LINES - 1)), line]);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Keep the tail in view as lines stream in (and when switching back to the tab).
  useEffect(() => {
    if (tab === 'output' && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [logLines, tab]);

  return (
    <section className="bottom-panel" data-testid="bottom-panel" aria-label="Panel">
      <div className="panel-tabs">
        {TABS.map(entry => (
          <button
            key={entry.id}
            role="tab"
            aria-selected={tab === entry.id}
            data-testid={`panel-tab-${entry.id}`}
            className={`panel-tab${tab === entry.id ? ' active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}

        <span className="spacer" />

        {/* The reference labels the active terminal, then offers new / split /
            kill / overflow, a divider, and finally the panel close. */}
        <span className="panel-source">
          <Icon name="terminal" size={14} />
          Agent Host Terminal
        </span>
        <button className="icon-btn icon-btn-sm" aria-label="New terminal">
          <Icon name="plus" size={14} />
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Terminal options">
          <Icon name="chevron-down" size={13} />
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Split terminal">
          <Icon name="split-horizontal" size={14} />
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Kill terminal">
          <Icon name="trash" size={14} />
        </button>
        <button className="icon-btn icon-btn-sm" aria-label="Views and more actions">
          <Icon name="ellipsis" size={14} />
        </button>
        <span className="panel-divider" />
        <button className="icon-btn icon-btn-sm" aria-label="Close panel" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </div>

      <div className="panel-body" role="tabpanel">
        {tab === 'terminal' ? (
          <div className="terminal-line">
            {/* A powerline prompt, rendered as chevron-joined segments the way
                the reference's shell theme draws it. */}
            <span className="seg seg-user">davacr</span>
            <span className="seg seg-repo">
              <Icon name="folder" size={12} />
              ticket-manager
            </span>
            <span className="seg seg-branch">
              <Icon name="git-branch" size={12} />
              main
            </span>
            <span className="terminal-caret" />
          </div>
        ) : (
          <div className="output-log" ref={outputRef} data-testid="output-log">
            {logLines.length === 0 ? (
              <div className="panel-empty">No output yet.</div>
            ) : (
              logLines.map((line, index) => (
                <div className="output-line" key={index}>
                  {line}
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  );
}
