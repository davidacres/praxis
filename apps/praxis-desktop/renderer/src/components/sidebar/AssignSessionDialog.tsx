import React, { useState, useEffect } from 'react';
import type { AgentSessionRecord, ProjectRecord, IssueSummary } from '@praxis/core';
import { Icon } from '../../ui/Icon';
import { ChipSelect } from '../../ui/ChipSelect';
import { sessionTitle } from '../../ai/sessionNav';

export interface AssignSessionDialogProps {
  session?: AgentSessionRecord;
  assignableProjects: ProjectRecord[];
  onClose: () => void;
  onAssign: (sessionKey: string, projectId: string, ticketKey?: string) => Promise<void>;
}

export function AssignSessionDialog({
  session,
  assignableProjects,
  onClose,
  onAssign
}: AssignSessionDialogProps) {
  if (!session) return null;

  const [assignProjectId, setAssignProjectId] = useState(() => session.projectId || assignableProjects[0]?.id || '');
  const [assignTicketKey, setAssignTicketKey] = useState(() => session.linkedIssueKey || '');
  const [assigning, setAssigning] = useState(false);
  const [assignProjectTickets, setAssignProjectTickets] = useState<IssueSummary[]>([]);
  const [assignTicketsLoading, setAssignTicketsLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setAssignProjectId(session.projectId || assignableProjects[0]?.id || '');
    setAssignTicketKey(session.linkedIssueKey || '');
    setError(undefined);
  }, [session, assignableProjects]);

  useEffect(() => {
    if (!assignProjectId) {
      setAssignProjectTickets([]);
      return;
    }
    let cancelled = false;
    setAssignTicketsLoading(true);
    void window.praxis.issue
      .list(
        { projectKeys: [], statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' },
        0,
        200,
        `project:${assignProjectId}`
      )
      .then(page => { if (!cancelled) setAssignProjectTickets(page.issues ?? []); })
      .catch(() => { if (!cancelled) setAssignProjectTickets([]); })
      .finally(() => { if (!cancelled) setAssignTicketsLoading(false); });
    return () => { cancelled = true; };
  }, [assignProjectId]);

  return (
    <div
      className="modal-overlay"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !assigning) onClose();
      }}
    >
      <section
        className="modal-card session-assign-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="assign-chat-title"
        data-testid="assign-chat-dialog"
      >
        <header className="modal-header session-assign-header">
          <div className="session-assign-heading">
            <h3 id="assign-chat-title">Assign chat to a project</h3>
            <p className="session-assign-description">Choose where “{sessionTitle(session)}” belongs.</p>
          </div>
          <button
            type="button"
            className="icon-btn icon-btn-sm"
            aria-label="Close assignment dialog"
            title="Close"
            onClick={() => { if (!assigning) onClose(); }}
            disabled={assigning}
          >
            <Icon name="close" size={13} />
          </button>
        </header>
        <div className="modal-body session-assign-body">
          <div className="session-assign-field">
            <span className="session-assign-field-label">Project</span>
            <ChipSelect
              value={assignProjectId}
              options={assignableProjects.map(project => ({ value: project.id, label: project.name, icon: 'folder' as const }))}
              onChange={value => {
                setAssignProjectId(value);
                setAssignTicketKey('');
              }}
              ariaLabel="Project"
              placeholder="Select a project"
              icon="folder"
              block
              data-testid="assign-chat-project-select"
            />
          </div>
          <div className="session-assign-field">
            <span className="session-assign-field-label">Ticket <span>(optional)</span></span>
            <ChipSelect
              value={assignTicketKey}
              options={[
                { value: '', label: 'General', icon: 'chats' },
                ...(assignProjectTickets.length > 0
                  ? assignProjectTickets
                  : assignableProjects.find(project => project.id === assignProjectId)?.workItems ?? []
                ).map(item => ({ value: item.key, label: `${item.key} · ${item.summary}`, icon: 'ticket' as const }))
              ]}
              onChange={setAssignTicketKey}
              ariaLabel="Ticket (optional)"
              placeholder={assignTicketsLoading ? 'Loading tickets…' : 'General'}
              icon="ticket"
              block
              disabled={!assignProjectId || assignTicketsLoading}
              data-testid="assign-chat-ticket-select"
            />
          </div>
        </div>
        {error && <div className="error-banner">{error}</div>}
        <footer className="modal-footer session-assign-footer">
          <button type="button" className="btn" onClick={onClose} disabled={assigning}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!assignProjectId || assigning}
            data-testid="assign-chat-confirm"
            onClick={() => {
              setAssigning(true);
              setError(undefined);
              void onAssign(session.issueKey, assignProjectId, assignTicketKey || undefined)
                .then(() => onClose())
                .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
                .finally(() => setAssigning(false));
            }}
          >
            {assigning ? 'Assigning…' : 'Assign chat'}
          </button>
        </footer>
      </section>
    </div>
  );
}
