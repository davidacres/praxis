import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Board, Connection, IssueSummary, UpdateIssueInput } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { resolveBackendMode } from '../board/boardMeta';
import {
  getCreatableTypes,
  getDraftParentRule,
  isIdeaDraftType,
  PRIORITY_OPTIONS,
  SEVERITY_OPTIONS
} from './issueDraftFields';
import { ChipSelect } from '../ui/ChipSelect';

interface NewIssuePageProps {
  board: Board;
  /** Undefined means the built-in demo backend. */
  connection: Connection | undefined;
  /**
   * Pre-selected issue type (e.g. 'Idea' from the board's New idea button).
   * Ignored when the board's backend doesn't offer that type.
   */
  initialIssueType?: string;
  onCancel: () => void;
  onCreated: (issueKey: string) => void;
}

function FieldRow({
  label,
  description,
  children
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-field-row">
      <div className="settings-field-label">
        <strong>{label}</strong>
        {description && <div className="settings-field-help">{description}</div>}
      </div>
      <div className="settings-field-control">{children}</div>
    </div>
  );
}

/**
 * Full-pane create-ticket form. Mirrors the extension's draft flow
 * (`issueDetailPanelManager.handleDraftCreate`): `issue.create` takes the
 * structural fields (project, type, summary, description, parent), then a
 * follow-up `issue.update` applies the metadata create doesn't accept
 * (assignee, priority, severity, reportedBy). A failed follow-up never
 * discards the created ticket — the form shows the warning and offers to open
 * the ticket as created.
 */
export function NewIssuePage({ board, connection, initialIssueType, onCancel, onCreated }: NewIssuePageProps) {
  // A project board's synthetic `project:<id>` connection has no row in the
  // connection store, so derive the mode from the board's own connection id.
  const mode = resolveBackendMode(connection?.id ?? board.connectionId, connection ? [connection] : []);
  const connectionId = connection?.id;
  const typeOptions = useMemo(() => getCreatableTypes(mode), [mode]);

  const [issueType, setIssueType] = useState(
    initialIssueType && typeOptions.includes(initialIssueType) ? initialIssueType : typeOptions[0]
  );
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [ideaTranscript, setIdeaTranscript] = useState('');
  const [parentText, setParentText] = useState('');
  const [priority, setPriority] = useState('');
  const [assignee, setAssignee] = useState('');
  const [severity, setSeverity] = useState('');
  const [reportedBy, setReportedBy] = useState('');

  const [projectKey, setProjectKey] = useState(board.projectKey ?? '');
  const [parentItems, setParentItems] = useState<IssueSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [followUpIssue, setFollowUpIssue] = useState<{ key: string; warning: string } | undefined>();

  const parentRule = getDraftParentRule(issueType, mode);

  useEffect(() => {
    let cancelled = false;
    void window.praxis.issue
      .getProjects(connectionId)
      .then(projects => {
        if (cancelled) {
          return;
        }
        setProjectKey(current => current || board.projectKey || projects[0]?.key || '');
      })
      .catch(() => {
        /* project list is a convenience default — the board's own key still applies */
      });
    return () => {
      cancelled = true;
    };
  }, [connectionId, board.projectKey]);

  // The allowed parent types change with the selected issue type, so the
  // picker reloads whenever either the type or the project changes.
  useEffect(() => {
    if (!parentRule.canHaveParent || !projectKey) {
      setParentItems([]);
      return;
    }
    let cancelled = false;
    void window.praxis.issue
      .getParentItems(
        {
          projectKeys: [projectKey],
          statuses: [],
          issueTypes: [],
          searchText: '',
          assigneeMode: 'all',
          grouping: 'none'
        },
        undefined,
        { childIssueType: issueType },
        connectionId
      )
      .then(items => {
        if (!cancelled) {
          setParentItems(items);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setParentItems([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [parentRule.canHaveParent, projectKey, issueType, connectionId]);

  /**
   * The parent field is free text backed by a datalist: a value matching an
   * item's key (or "key — summary" label) means "existing parent"; anything
   * else is a new Feature name where the backend supports that, else a
   * validation error.
   */
  const resolveParent = useCallback((): { parentKey?: string; newParentSummary?: string; error?: string } => {
    const text = parentText.trim();
    if (!text) {
      return parentRule.requiresParent
        ? { error: `${parentRule.label} is required for ${issueType} items.` }
        : {};
    }
    const lowered = text.toLowerCase();
    const match = parentItems.find(
      item =>
        item.key.toLowerCase() === lowered ||
        `${item.key} — ${item.summary}`.toLowerCase() === lowered ||
        item.summary.toLowerCase() === lowered
    );
    if (match) {
      return { parentKey: match.key };
    }
    if (parentRule.allowsNewParent) {
      return { newParentSummary: text };
    }
    return { error: `"${text}" is not an existing ${parentRule.label}. Pick one from the list or clear the field.` };
  }, [parentText, parentRule, parentItems, issueType]);

  const submit = useCallback(async () => {
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) {
      setError('Summary is required.');
      return;
    }
    if (!projectKey) {
      setError('No project could be resolved for this board.');
      return;
    }
    const parent = resolveParent();
    if (parent.error) {
      setError(parent.error);
      return;
    }

    setBusy(true);
    setError(undefined);
    try {
      const created = await window.praxis.issue.create(
        {
          projectKey,
          issueType,
          summary: trimmedSummary,
          description: description.trim() || undefined,
          // Only sent for ideas, and only when filled — backends that don't
          // support the field must never see it (GitLab rejects unknown keys).
          ...(isIdeaDraftType(issueType) && ideaTranscript.trim()
            ? { ideaTranscript: ideaTranscript.trim() }
            : {}),
          parentKey: parent.parentKey,
          newParentSummary: parent.newParentSummary,
          boardId: board.id
        },
        connectionId
      );

      // Fields create doesn't accept, applied only when set. A failure here is
      // surfaced but never discards the created ticket.
      const followUp: UpdateIssueInput = {
        ...(assignee.trim() ? { assignee: assignee.trim() } : {}),
        ...(priority ? { priority } : {}),
        ...(severity ? { severity } : {}),
        ...(reportedBy.trim() ? { reportedBy: reportedBy.trim() } : {})
      };
      if (Object.keys(followUp).length > 0) {
        try {
          await window.praxis.issue.update(created.key, followUp, connectionId);
        } catch (followUpError) {
          setFollowUpIssue({
            key: created.key,
            warning: `Created ${created.key}, but some fields could not be applied: ${
              followUpError instanceof Error ? followUpError.message : String(followUpError)
            }`
          });
          return;
        }
      }
      onCreated(created.key);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(false);
    }
  }, [
    summary,
    projectKey,
    issueType,
    description,
    ideaTranscript,
    resolveParent,
    board.id,
    connectionId,
    assignee,
    priority,
    severity,
    reportedBy,
    onCreated
  ]);

  if (followUpIssue) {
    return (
      <div className="new-issue-page" data-testid="new-issue-page">
        <div className="empty-state">
          <Icon name="info" size={28} />
          <span data-testid="new-issue-warning">{followUpIssue.warning}</span>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onCreated(followUpIssue.key)}
          >
            Open {followUpIssue.key}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="new-issue-page" data-testid="new-issue-page">
      <header className="view-header">
        <strong>New issue</strong>
        <span className="new-issue-context">
          {board.name}
          {connection ? ` · ${connection.name}` : ' · Demo'}
        </span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-testid="new-issue-submit"
          disabled={busy}
          onClick={() => void submit()}
        >
          Create issue
        </button>
      </header>

      <div className="view-scroll">
        <div className="new-issue-form">
          {error && (
            <div className="error-banner" data-testid="new-issue-error">
              {error}
            </div>
          )}

          <FieldRow label="Type">
            <ChipSelect
              block
              ariaLabel="Type"
              data-testid="new-issue-type"
              value={issueType}
              onChange={value => {
                setIssueType(value);
                setParentText('');
              }}
              options={typeOptions.map(type => ({ value: type, label: type }))}
            />
          </FieldRow>

          <FieldRow label="Summary">
            <input
              className="input new-issue-grow"
              data-testid="new-issue-summary"
              placeholder="What needs doing?"
              value={summary}
              onChange={event => setSummary(event.target.value)}
              autoFocus
            />
          </FieldRow>

          <FieldRow label="Description">
            <textarea
              className="textarea"
              data-testid="new-issue-description"
              rows={6}
              value={description}
              onChange={event => setDescription(event.target.value)}
            />
          </FieldRow>

          {isIdeaDraftType(issueType) && (
            <FieldRow
              label="Research transcript"
              description="Idea tickets keep research here instead of code delivery workflows."
            >
              <textarea
                className="textarea"
                data-testid="new-issue-idea-transcript"
                rows={5}
                placeholder="Paste the AI research conversation or notes for this idea…"
                value={ideaTranscript}
                onChange={event => setIdeaTranscript(event.target.value)}
              />
            </FieldRow>
          )}

          {parentRule.canHaveParent && (
            <FieldRow
              label={parentRule.label}
              description={parentRule.helperText}
            >
              <input
                className="input new-issue-grow"
                data-testid="new-issue-parent"
                list="new-issue-parent-options"
                placeholder={parentRule.placeholder}
                value={parentText}
                onChange={event => setParentText(event.target.value)}
              />
              <datalist id="new-issue-parent-options">
                {parentItems.map(item => (
                  <option key={item.key} value={`${item.key} — ${item.summary}`} />
                ))}
              </datalist>
            </FieldRow>
          )}

          <FieldRow label="Priority">
            <ChipSelect
              block
              ariaLabel="Priority"
              data-testid="new-issue-priority"
              value={priority}
              onChange={setPriority}
              options={[{ value: '', label: '—' }, ...PRIORITY_OPTIONS.map(option => ({ value: option, label: option }))]}
            />
          </FieldRow>

          <FieldRow label="Assignee">
            <input
              className="input new-issue-grow"
              data-testid="new-issue-assignee"
              value={assignee}
              onChange={event => setAssignee(event.target.value)}
            />
          </FieldRow>

          <FieldRow label="Severity">
            <ChipSelect
              block
              ariaLabel="Severity"
              data-testid="new-issue-severity"
              value={severity}
              onChange={setSeverity}
              options={[{ value: '', label: '—' }, ...SEVERITY_OPTIONS.map(option => ({ value: option, label: option }))]}
            />
          </FieldRow>

          <FieldRow label="Reported by">
            <input
              className="input new-issue-grow"
              data-testid="new-issue-reported-by"
              value={reportedBy}
              onChange={event => setReportedBy(event.target.value)}
            />
          </FieldRow>
        </div>
      </div>
    </div>
  );
}
