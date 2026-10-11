import { useEffect, useRef, useState } from 'react';
import type { Board, Connection, IssueSummary } from '@praxis/core';
import { backendModeMeta, resolveBackendMode } from '../board/boardMeta';
import { ChipSelect } from '../ui/ChipSelect';
import { Icon } from '../ui/Icon';
import { getCreatableTypes, getDraftParentRule } from './issueDraftFields';

/** Shared with the ordinary board create button; main remains the permission enforcer. */
export function issueCreationAvailability(connection: Connection | undefined): { allowed: boolean; hint?: string } {
  if (!connection || connection.mode === 'demo') return { allowed: true };
  if (['app', 'folder', 'project', 'github'].includes(connection.mode)) {
    return connection.settings.allowIssueCreation === true
      ? { allowed: true }
      : { allowed: false, hint: 'Issue creation is disabled for this connection. Enable "Allow issue creation" in its settings.' };
  }
  return { allowed: false, hint: `Ticket creation is not available for ${backendModeMeta(connection.mode).label} connections yet.` };
}

interface QuickCaptureProps {
  open: boolean;
  boards: Board[];
  connections: Connection[];
  initialBoard?: Board;
  onClose: () => void;
  onCreated: (board: Board, issueKey: string) => void;
}

/** Kept mounted by App so dismissing or a failed submission never discards the draft. */
export function QuickCapture({ open, boards, connections, initialBoard, onClose, onCreated }: QuickCaptureProps) {
  const [boardId, setBoardId] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [issueType, setIssueType] = useState('Task');
  const [parentText, setParentText] = useState('');
  const [projectKey, setProjectKey] = useState('');
  const [projects, setProjects] = useState<{ key: string; name: string }[]>([]);
  const [parents, setParents] = useState<IssueSummary[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const destinationKey = (item: Board) => `${item.connectionId ?? 'demo'}:${item.id}`;
  const board = boards.find(item => destinationKey(item) === boardId);
  const captureProjectKey = board?.projectKey || projectKey;
  const connection = connections.find(item => item.id === board?.connectionId);
  const mode = resolveBackendMode(board?.connectionId, connections);
  const availability = issueCreationAvailability(connection);
  const types = getCreatableTypes(mode);
  const parentRule = getDraftParentRule(issueType, mode);
  const allowed = Boolean(board && board.availability !== 'missing' && availability.allowed);
  const connectionId = connection?.id ?? board?.connectionId;

  useEffect(() => {
    if (!open) return;
    setBoardId(current => current || (initialBoard ? destinationKey(initialBoard) : ''));
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => titleRef.current?.focus());
    return () => { cancelAnimationFrame(frame); previous?.focus(); };
  }, [open, initialBoard?.id, initialBoard?.connectionId]);

  useEffect(() => {
    if (!open || !board || board.projectKey || !allowed) return;
    let cancelled = false;
    void window.praxis.issue.getProjects(connectionId).then(items => { if (!cancelled) setProjects(items); })
      .catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { cancelled = true; };
  }, [open, boardId, board?.projectKey, allowed, connectionId]);

  useEffect(() => {
    if (!open || !captureProjectKey || !parentRule.canHaveParent || !allowed) { setParents([]); return; }
    let cancelled = false;
    void window.praxis.issue.getParentItems({
      projectKeys: [captureProjectKey], statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none'
    }, undefined, { childIssueType: issueType }, connectionId)
      .then(items => { if (!cancelled) setParents(items); })
      .catch(() => { if (!cancelled) setParents([]); });
    return () => { cancelled = true; };
  }, [open, captureProjectKey, parentRule.canHaveParent, allowed, issueType, connectionId]);

  // Saving disables every control, which drops focus to <body>; pull it back so Escape and Tab keep working.
  useEffect(() => {
    if (open && !busy && !dialogRef.current?.contains(document.activeElement)) titleRef.current?.focus();
  }, [open, busy]);

  const submit = async () => {
    if (busy || !allowed || !board) return;
    if (!title.trim()) { setError('Title is required.'); titleRef.current?.focus(); return; }
    const text = parentText.trim();
    const parent = parents.find(item => [item.key, item.summary, `${item.key} — ${item.summary}`].some(value => value.toLowerCase() === text.toLowerCase()));
    if (parentRule.requiresParent && !text) { setError(`${parentRule.label} is required for ${issueType} items.`); return; }
    if (text && !parent && !parentRule.allowsNewParent) { setError(`Choose an existing ${parentRule.label} or clear the field.`); return; }
    setBusy(true);
    setError(undefined);
    try {
      if (!captureProjectKey) throw new Error('Choose the destination project before saving.');
      const created = await window.praxis.issue.create({
        projectKey: captureProjectKey, boardId: board.id, issueType, summary: title.trim(), description: body.trim() || undefined, origin: 'capture',
        ...(parentRule.canHaveParent && parent ? { parentKey: parent.key } : {}),
        ...(parentRule.canHaveParent && text && !parent && parentRule.allowsNewParent ? { newParentSummary: text } : {})
      }, connectionId);
      setTitle(''); setBody(''); setParentText(''); setBoardId(''); setProjectKey(''); setIssueType('Task');
      onCreated(board, created.key);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  if (!open) return null;
  return (
    <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <div className="modal-card quick-capture" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Quick Capture" data-testid="quick-capture-dialog"
        onKeyDown={event => {
          if (event.key === 'Escape' && !busy) { event.preventDefault(); event.stopPropagation(); onClose(); }
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit(); }
          if (event.key === 'Tab') {
            const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled)') ?? []);
            const first = controls[0]; const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <div className="modal-header"><h3>Quick Capture</h3><button className="btn-icon" type="button" aria-label="Close Quick Capture" disabled={busy} onClick={onClose}><Icon name="close" size={13} /></button></div>
        <form onSubmit={event => { event.preventDefault(); void submit(); }}>
          <div className="modal-body quick-capture-fields">
            <label className="app-dialog-field"><span>Title</span><input className="input" ref={titleRef} data-testid="quick-capture-title" value={title} disabled={busy} onChange={event => setTitle(event.target.value)} placeholder="What needs doing?" aria-invalid={title.length > 0 && !title.trim()} aria-describedby={title.length > 0 && !title.trim() ? 'quick-capture-title-hint' : undefined} />{title.length > 0 && !title.trim() && <small id="quick-capture-title-hint" role="alert" className="error-text" data-testid="quick-capture-title-hint">A title can't be only spaces.</small>}</label>
            <label className="app-dialog-field"><span>Details (optional)</span><textarea className="textarea" rows={3} data-testid="quick-capture-body" value={body} disabled={busy} onChange={event => setBody(event.target.value)} /></label>
            <label className="app-dialog-field"><span>Destination</span><ChipSelect ariaLabel="Capture destination" data-testid="quick-capture-destination" block value={boardId} disabled={busy} placeholder="Choose a project board" options={boards.map(item => ({ value: destinationKey(item), label: item.name, description: item.projectName || item.projectKey }))} onChange={value => { setBoardId(value); setProjectKey(''); setProjects([]); setParentText(''); setError(undefined); }} /></label>
            {!board && <p className="settings-field-help">Choose a destination before saving.{boards.length === 0 ? ' Add a project or connection to create its first board.' : ''}</p>}
            {board && !allowed && <p role="status" className="settings-field-help" data-testid="quick-capture-unavailable">{board.availability === 'missing' ? board.availabilityMessage || 'This board is unavailable.' : availability.hint}</p>}
            {board && allowed && <>
              {!board.projectKey && <label className="app-dialog-field"><span>Project</span><ChipSelect ariaLabel="Capture project" data-testid="quick-capture-project" block value={projectKey} disabled={busy} placeholder="Choose a project" options={projects.map(project => ({ value: project.key, label: project.name || project.key, description: project.key }))} onChange={value => { setProjectKey(value); setParentText(''); }} /></label>}
              <label className="app-dialog-field"><span>Type</span><ChipSelect ariaLabel="Capture type" data-testid="quick-capture-type" block value={issueType} disabled={busy} options={types.map(type => ({ value: type, label: type }))} onChange={value => { setIssueType(value); setParentText(''); setError(undefined); }} /></label>
              {parentRule.canHaveParent && <label className="app-dialog-field"><span>{parentRule.label}{parentRule.requiresParent ? ' (required)' : ' (optional)'}</span><input className="input" data-testid="quick-capture-parent" list="quick-capture-parents" placeholder={parentRule.placeholder} disabled={busy} value={parentText} onChange={event => setParentText(event.target.value)} /><datalist id="quick-capture-parents">{parents.map(parent => <option key={parent.key} value={`${parent.key} — ${parent.summary}`} />)}</datalist><small className="settings-field-help">{parentRule.helperText}</small></label>}
            </>}
            {error && <p role="alert" data-testid="quick-capture-error" className="error-text">{error}</p>}
          </div>
          <div className="modal-footer"><button className="btn" type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="btn btn-primary" data-testid="quick-capture-save" disabled={!allowed || busy || !title.trim() || !captureProjectKey} type="submit">{busy ? 'Saving…' : 'Save capture'}</button></div>
        </form>
      </div>
    </div>
  );
}
