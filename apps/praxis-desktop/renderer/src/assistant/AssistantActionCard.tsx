import { useState } from 'react';
import type { AssistantProposedAction } from '@praxis/core';
import { Icon } from '../ui/Icon';
import { describeAction } from './assistantActions';

interface AssistantActionCardProps {
  action: AssistantProposedAction;
  /** Outcome line once applied. */
  applied?: string;
  disabled: boolean;
  onApply: () => void;
}

/** A proposed change: read what it will do, preview the exact content, then apply it in one click. */
export function AssistantActionCard({ action, applied, disabled, onApply }: AssistantActionCardProps) {
  const [previewing, setPreviewing] = useState(false);
  const { icon, previewTitle, preview } = describeAction(action);
  return (
    <div className="assistant-action-card" data-testid="assistant-action-card">
      <div className="assistant-action-summary">
        <Icon name={icon} size={13} />
        <span>{action.summary}</span>
      </div>
      <div className="assistant-action-buttons">
        <button type="button" className="btn btn-sm" aria-expanded={previewing} data-testid="assistant-action-preview" onClick={() => setPreviewing(open => !open)}>
          {previewing ? 'Hide Preview' : 'Preview Changes'}
        </button>
        {applied ? (
          <span className="assistant-action-done"><Icon name="check" size={12} /> {applied}</span>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" data-testid="assistant-action-apply" disabled={disabled} onClick={onApply}>{action.label}</button>
        )}
      </div>
      {previewing && (
        <div className="assistant-action-preview" data-testid="assistant-action-preview-body">
          <strong>{previewTitle}</strong>
          <pre>{preview}</pre>
        </div>
      )}
    </div>
  );
}
