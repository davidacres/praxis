import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSessionRecord, NoteRequestSnapshot } from '@praxis/core';
import { sessionLabel } from '../ai/sessionNav';
import { ChipSelect } from '../ui/ChipSelect';
import { Icon } from '../ui/Icon';
import { notesClient } from './notesClient';
import { flush } from './notesSession';
import { compatibleNoteSessions, defaultNoteInstruction, snapshotToReference } from './noteSendReference';
import {
  NEW_SESSION_HANDOFF, closeNoteSend, draftInstruction, saveDraftInstruction, stageSessionHandoff, useNoteSendRequest
} from './noteSendStore';

const NEW_SESSION = '__new__';

type Capture = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; snapshot: NoteRequestSnapshot };

/**
 * Preview and explicit send of a note or ordered group. Opening it only reads storage;
 * nothing reaches a provider until the destination session's own composer sends.
 */
export function NoteSendDialog({ sessions, onOpenSession, onNewSession }: {
  sessions: AgentSessionRecord[];
  onOpenSession: (issueKey: string) => void;
  onNewSession: (projectId: string, goal: string) => void;
}) {
  const request = useNoteSendRequest();
  if (!request) return null;
  return <Dialog key={`${request.projectId}:${request.source.kind}:${request.source.id}`} request={request}
    sessions={sessions} onOpenSession={onOpenSession} onNewSession={onNewSession} />;
}

function Dialog({ request, sessions, onOpenSession, onNewSession }: {
  request: NonNullable<ReturnType<typeof useNoteSendRequest>>;
  sessions: AgentSessionRecord[];
  onOpenSession: (issueKey: string) => void;
  onNewSession: (projectId: string, goal: string) => void;
}) {
  const { projectId, source } = request;
  const [capture, setCapture] = useState<Capture>({ state: 'loading' });
  const [instruction, setInstruction] = useState(() => draftInstruction(projectId, source));
  const [sending, setSending] = useState(false);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const openerRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const destinations = useMemo(() => compatibleNoteSessions(sessions, projectId), [sessions, projectId]);
  const [chosen, setChosen] = useState<string>(() => destinations[0]?.issueKey ?? NEW_SESSION);
  const target = chosen === NEW_SESSION ? undefined : destinations.find(session => session.issueKey === chosen);
  // A chosen session that has since gone must never quietly turn into "new session".
  const destinationGone = chosen !== NEW_SESSION && !target;
  const toNew = chosen === NEW_SESSION;
  const confirmingRef = useRef(false);

  useEffect(() => {
    let live = true;
    // Capture after the editor's pending autosave lands so the preview matches what is on screen.
    void flush().then(() => notesClient.prepareSnapshot(projectId, source)).then(outcome => {
      if (live) setCapture(outcome.ok ? { state: 'ready', snapshot: outcome.value } : { state: 'error', message: outcome.message });
    });
    return () => { live = false; };
  }, [projectId, source.kind, source.id]);

  // Take focus on open so Escape and Tab act on the dialog, and hand it back to the opener on close.
  useEffect(() => {
    instructionRef.current?.focus();
    const opener = openerRef.current;
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  const close = () => { saveDraftInstruction(projectId, source, instruction); closeNoteSend(); };

  const confirm = () => {
    if (confirmingRef.current || sending || destinationGone || capture.state !== 'ready') return;
    confirmingRef.current = true;
    setSending(true);
    const { snapshot } = capture;
    const text = instruction.trim() || defaultNoteInstruction(snapshot);
    saveDraftInstruction(projectId, source, instruction);
    stageSessionHandoff(target ? target.issueKey : NEW_SESSION_HANDOFF, {
      reference: snapshotToReference(snapshot), instruction: text, draft: { projectId, source }
    });
    closeNoteSend();
    if (target) onOpenSession(target.issueKey); else onNewSession(projectId, text);
  };

  return <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="modal-card note-send-dialog" role="dialog" aria-modal="true" aria-label="Send to session"
      data-testid="note-send-dialog"
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key !== 'Tab') return;
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
          'button:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )).filter(element => element.getClientRects().length > 0);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="modal-header">
        <h3>Send to session</h3>
        <button type="button" className="btn-icon" aria-label="Close" onClick={close}><Icon name="close" size={13} /></button>
      </div>
      <div className="modal-body note-send-dialog__body">
        <div className="note-send-dialog__field">
          <span className="note-send-dialog__label">Destination</span>
          <ChipSelect block ariaLabel="Destination session" data-testid="note-send-destination" value={chosen}
            options={[
              ...(destinationGone ? [{ value: chosen, label: 'Unavailable session', icon: 'chats' as const }] : []),
              ...destinations.map(session => ({ value: session.issueKey, label: sessionLabel(session), icon: 'chats' as const })),
              { value: NEW_SESSION, label: 'New session…', icon: 'plus' as const }
            ]}
            onChange={setChosen} />
          {destinationGone && <p className="note-send-dialog__status" role="alert" data-testid="note-send-destination-error">
            That session is no longer available — choose another destination.</p>}
        </div>
        <div className="note-send-dialog__preview" data-testid="note-send-preview" aria-live="polite">
          {capture.state === 'loading' && <p className="note-send-dialog__status">Preparing preview…</p>}
          {capture.state === 'error' && <p className="note-send-dialog__status" role="alert" data-testid="note-send-error">{capture.message}</p>}
          {capture.state === 'ready' && <>
            <p className="note-send-dialog__source">{capture.snapshot.source.title}
              <span> · {capture.snapshot.notes.length} {capture.snapshot.notes.length === 1 ? 'note' : 'notes'}</span></p>
            <ol className="note-send-dialog__notes">
              {capture.snapshot.notes.map(note => <li key={note.id} data-testid="note-send-preview-note">
                <strong>{note.title}</strong>
                {note.body && <pre>{note.body}</pre>}
              </li>)}
            </ol>
          </>}
        </div>
        <label className="note-send-dialog__field">
          <span className="note-send-dialog__label">Instructions (optional)</span>
          <textarea ref={instructionRef} className="note-send-dialog__instruction" rows={3} value={instruction} data-testid="note-send-instruction"
            placeholder="What should the session do with this?" onChange={event => setInstruction(event.target.value)} />
        </label>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn" data-testid="note-send-cancel" onClick={close}>Cancel</button>
        <button type="button" className="btn btn-primary" data-testid="note-send-confirm"
          disabled={sending || destinationGone || capture.state !== 'ready'} onClick={confirm}>
          {toNew ? 'Continue in new session' : 'Send'}
        </button>
      </div>
    </div>
  </div>;
}
