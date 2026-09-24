import { useEffect, useState } from 'react';
import type { WorkflowRunSummary } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { Markdown } from '../ui/Markdown';

type StageRow = WorkflowRunSummary['stages'][number];

/**
 * A stage's outputs in the run's right pane. A report or plan is the stage session's final
 * response, so it can be read, copied, or saved as Markdown straight from here; a plan the stage
 * published to the board shows the plan's id and opens it there.
 */
export function StageArtifacts({
  runId,
  stage,
  onOpenBoardItem
}: {
  runId: string;
  stage: StageRow;
  onOpenBoardItem?: (issueKey: string) => void;
}) {
  const [reading, setReading] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const written = stage.artifacts.find(artifact => artifact.kind === 'report' || artifact.kind === 'plan');
  const noun = written?.kind === 'plan' ? 'plan' : 'report';
  const canRead = stage.type === 'agent-task' && stage.outcome === 'succeeded' && !!written;

  const load = async (): Promise<string | undefined> => {
    const text = await window.praxis.workflows.stageReport(runId, stage.nodeId);
    if (!text) setNotice(`This stage's ${noun} is no longer available.`);
    return text || undefined;
  };

  const copy = async () => {
    const text = await load();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setNotice('Copied as Markdown.');
  };

  const save = async () => {
    try {
      const result = await window.praxis.workflows.saveStageReport(runId, stage.nodeId);
      if (result.saved) setNotice(`Saved to ${result.path}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  if (stage.artifacts.length === 0) return null;

  return (
    <>
      <ul className="wf-stage-artifacts">
        {stage.artifacts.map(artifact => (
          <li key={artifact.contractId}>
            {artifact.reference ? (
              <span className="wf-artifact-plan" data-testid="wf-published-plan">
                Plan <strong>{artifact.reference.key}</strong> created on the board — {artifact.reference.title} ·{' '}
                {artifact.reference.itemKeys.length} {artifact.reference.itemKeys.length === 1 ? 'item' : 'items'}
                {onOpenBoardItem && (
                  <button
                    type="button"
                    className="btn btn-compact"
                    onClick={() => onOpenBoardItem(artifact.reference!.key)}
                  >
                    Open on board
                  </button>
                )}
              </span>
            ) : (
              <>
                {artifact.kind}: {artifact.contractId}
              </>
            )}
          </li>
        ))}
      </ul>
      {canRead && (
        <div className="wf-stage-report-actions">
          <button
            type="button"
            className="btn btn-compact"
            data-testid="wf-read-report"
            onClick={() => void load().then(text => setReading(text))}
          >
            <Icon name="markdown" size={12} /> Read {noun}
          </button>
          <button type="button" className="btn btn-compact" onClick={() => void copy()}>
            Copy
          </button>
          <button type="button" className="btn btn-compact" onClick={() => void save()}>
            Save as Markdown…
          </button>
        </div>
      )}
      {notice && <p className="rail-sub wf-stage-report-notice">{notice}</p>}
      {reading !== undefined && (
        <StageReportDialog
          title={stage.name}
          text={reading}
          onCopy={() => void copy()}
          onSave={() => void save()}
          onClose={() => setReading(undefined)}
        />
      )}
    </>
  );
}

function StageReportDialog({
  title,
  text,
  onCopy,
  onSave,
  onClose
}: {
  title: string;
  text: string;
  onCopy: () => void;
  onSave: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="modal-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-card wf-report-dialog" role="dialog" aria-modal="true" aria-label={title} data-testid="wf-report-dialog">
        <div className="wf-report-dialog-head">
          <h3>{title}</h3>
          <button type="button" className="btn btn-compact" onClick={onCopy}>
            Copy
          </button>
          <button type="button" className="btn btn-compact" onClick={onSave}>
            Save as Markdown…
          </button>
          <button type="button" className="icon-btn icon-btn-sm" aria-label="Close" onClick={onClose}>
            <Icon name="close" size={13} />
          </button>
        </div>
        <div className="wf-report-dialog-body">
          <Markdown text={text} testId="wf-report-markdown" />
        </div>
      </div>
    </div>
  );
}
