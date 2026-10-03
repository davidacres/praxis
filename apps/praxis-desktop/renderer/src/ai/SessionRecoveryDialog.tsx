import { useEffect, useRef, useState } from 'react';
import type { AgentSessionRecord } from '@praxis/core';
import { providerLabel } from './modelProviders';
import './sessionRecovery.css';

/** Startup offers recovery; fetching or selecting a row never launches a turn. */
export function SessionRecoveryDialog() {
  const [sessions, setSessions] = useState<AgentSessionRecord[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const dialog = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.praxis.ai.listInterruptedSessions().then(records => {
      if (!cancelled) setSessions(records);
    }).catch(error => console.error('Failed to load interrupted sessions:', error));
    return () => { cancelled = true; };
  }, []);
  const open = sessions.length > 0;
  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement;
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => previousFocus.current?.focus();
  }, [open]);

  const leaveStopped = async () => {
    setBusy(true);
    try {
      await window.praxis.ai.dismissInterruptedSessions(sessions.map(session => session.issueKey));
      setSessions([]);
    } catch (error) {
      setErrors({ dialog: error instanceof Error ? error.message : String(error) });
    } finally { setBusy(false); }
  };
  const resumeSelected = async () => {
    setBusy(true);
    const failures: Record<string, string> = {};
    const resumed = new Set<string>();
    for (const session of sessions.filter(record => selected.has(record.issueKey))) {
      try {
        await window.praxis.ai.resumeInterruptedSession(session.issueKey);
        resumed.add(session.issueKey);
      } catch (error) {
        failures[session.issueKey] = error instanceof Error ? error.message : String(error);
      }
    }
    if (Object.keys(failures).length === 0) {
      try {
        await window.praxis.ai.dismissInterruptedSessions(sessions.filter(record => !resumed.has(record.issueKey)).map(record => record.issueKey));
        setSessions([]);
      } catch (error) { failures.dialog = error instanceof Error ? error.message : String(error); }
    }
    setSessions(current => current.filter(record => !resumed.has(record.issueKey)));
    setSelected(current => new Set([...current].filter(key => !resumed.has(key))));
    setErrors(failures);
    setBusy(false);
  };
  if (!open) return null;
  return <div className="modal-overlay">
    <div ref={dialog} className="modal-card session-recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="session-recovery-title" data-testid="session-recovery-dialog"
      onKeyDown={event => {
        if (event.key === 'Escape' && !busy) { event.preventDefault(); void leaveStopped(); }
        if (event.key === 'Tab') {
          const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
          if (!controls?.length) return;
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      }}>
      <div className="modal-header"><h3 id="session-recovery-title">Resume interrupted sessions?</h3></div>
      <div className="modal-body">
        <p>Praxis closed while these sessions were working. Choose which to continue. All sessions stay stopped until you resume them.</p>
        <button type="button" className="btn" disabled={busy} onClick={() => setSelected(selected.size === sessions.length ? new Set() : new Set(sessions.map(session => session.issueKey)))}>
          {selected.size === sessions.length ? 'Deselect all' : 'Select all'}
        </button>
        <div className="session-recovery-list">
          {sessions.map(session => <div key={session.issueKey} className="session-recovery-row">
            <label><input type="checkbox" disabled={busy} checked={selected.has(session.issueKey)} onChange={event => setSelected(current => {
              const next = new Set(current);
              if (event.target.checked) next.add(session.issueKey); else next.delete(session.issueKey);
              return next;
            })} />
              <span><strong>{session.title || session.taskDefinition.goal || session.issueKey}</strong>
                <small>{providerLabel(session.provider ?? '')} · {session.issueKey}{session.model ? ` · ${session.model}` : ''}</small>
              </span>
            </label>
            {errors[session.issueKey] && <p role="alert" className="session-recovery-error">{errors[session.issueKey]}</p>}
          </div>)}
        </div>
        {errors.dialog && <p role="alert" className="session-recovery-error">{errors.dialog}</p>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn" disabled={busy} onClick={() => void leaveStopped()}>Leave stopped</button>
        <button type="button" className="btn btn-primary" disabled={busy || selected.size === 0} onClick={() => void resumeSelected()}>{busy ? 'Working…' : `Resume selected (${selected.size})`}</button>
      </div>
    </div>
  </div>;
}
