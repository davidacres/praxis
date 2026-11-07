import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentSessionRecord } from '@praxis/core';
import { sessionLabel } from '../ai/sessionNav';
import { ChipSelect } from '../ui/ChipSelect';
import { Icon } from '../ui/Icon';
import { compatibleNoteSessions } from '../notes/noteSendReference';
import { NEW_SESSION_HANDOFF, stageSessionHandoff } from '../notes/noteSendStore';
import { artifactReference, type ArtifactSendTarget } from './artifactReference';

const NEW_SESSION = '__new__';

/**
 * Adds an artifact (or a group) to a chat as a context chip. Nothing is sent:
 * the chip waits in the chosen session's composer for the user's own message.
 */
export function ArtifactSendDialog({
  projectId,
  root,
  target,
  sessions,
  onClose,
  onOpenSession,
  onNewSession
}: {
  projectId: string;
  root?: string;
  target: ArtifactSendTarget;
  sessions: AgentSessionRecord[];
  onClose: () => void;
  onOpenSession: (sessionKey: string) => void;
  onNewSession: (projectId: string) => void;
}) {
  const destinations = useMemo(() => compatibleNoteSessions(sessions, projectId), [sessions, projectId]);
  const [chosen, setChosen] = useState<string>(() => destinations[0]?.issueKey ?? NEW_SESSION);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const cardRef = useRef<HTMLDivElement>(null);
  const items = target.kind === 'artifact' ? [target.item] : target.items;
  const destination = chosen === NEW_SESSION ? undefined : destinations.find(session => session.issueKey === chosen);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.querySelector<HTMLElement>('[data-testid="artifact-send-confirm"]')?.focus();
    return () => { if (opener?.isConnected) opener.focus(); };
  }, []);

  const add = async () => {
    if (adding) return;
    setAdding(true);
    setError(undefined);
    try {
      const reference = await artifactReference(projectId, root, target, window.praxis.artifacts.readText);
      stageSessionHandoff(destination ? destination.issueKey : NEW_SESSION_HANDOFF, { reference, instruction: '', attachOnly: true });
      onClose();
      if (destination) onOpenSession(destination.issueKey);
      else onNewSession(projectId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setAdding(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={cardRef}
        className="modal-card note-send-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add to chat"
        data-testid="artifact-send-dialog"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="modal-header">
          <h3>Add to chat</h3>
          <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" size={13} /></button>
        </div>
        <div className="modal-body note-send-dialog__body">
          <div className="note-send-dialog__field">
            <span className="note-send-dialog__label">Chat</span>
            <ChipSelect
              block
              ariaLabel="Chat to add to"
              data-testid="artifact-send-destination"
              value={chosen}
              options={[
                ...destinations.map(session => ({ value: session.issueKey, label: sessionLabel(session), icon: 'chats' as const })),
                { value: NEW_SESSION, label: 'New session…', icon: 'plus' as const }
              ]}
              onChange={setChosen}
            />
          </div>
          <div className="note-send-dialog__preview" data-testid="artifact-send-preview">
            <p className="note-send-dialog__source">
              {target.kind === 'group' ? target.name : target.item.title}
              {target.kind === 'group' && <span> · {items.length} {items.length === 1 ? 'file' : 'files'}</span>}
            </p>
            <ol className="note-send-dialog__notes">
              {items.map(item => <li key={item.path}><strong>{item.title}</strong> <code>{item.path}</code></li>)}
            </ol>
            <p className="note-send-dialog__status">
              It&rsquo;s attached to the chat&rsquo;s message box &mdash; nothing is sent until you send your message.
            </p>
          </div>
          {error && <p className="note-send-dialog__status" role="alert">{error}</p>}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" data-testid="artifact-send-confirm" disabled={adding} onClick={() => void add()}>
            {adding ? 'Adding…' : destination ? 'Add to chat' : 'Add to new session'}
          </button>
        </div>
      </div>
    </div>
  );
}
