import type { TaskDesignerCanvasNode } from '@praxis/core';
import { Icon, type IconName } from '../ui/Icon';
import { websitePreviewTitle } from './taskDesignerState';

export interface TaskDesignerItemDetailProps {
  node: TaskDesignerCanvasNode;
  onClose: () => void;
}

export function TaskDesignerItemDetail({ node, onClose }: TaskDesignerItemDetailProps) {
  const title =
    node.type === 'ticket'
      ? node.issueKey
      : node.type === 'note'
        ? node.title.trim() || 'Note'
        : websitePreviewTitle(node.url);
  const icon: IconName = node.type === 'ticket' ? 'ticket' : node.type === 'note' ? 'note' : 'globe';

  return (
    <div className="detail-panel designer-item-detail" data-testid="designer-item-detail">
      <header className="detail-header">
        <Icon name={icon} size={14} />
        <span className="view-title">{title}</span>
        <span className="designer-item-kind">{node.type === 'website' ? 'Website' : node.type}</span>
        <button
          type="button"
          className="icon-btn icon-btn-sm designer-item-detail-close"
          aria-label="Close designer item details"
          onClick={onClose}
        >
          <Icon name="close" size={13} />
        </button>
      </header>

      <div className="detail-body">
        {node.type === 'ticket' && (
          <>
            <section className="designer-item-summary">
              <div className="detail-section-label">Summary</div>
              <p>{node.summary || 'No summary'}</p>
            </section>
            <section className="detail-section designer-item-properties">
              <div className="detail-section-label">Ticket details</div>
              <dl>
                <div><dt>Type</dt><dd>{node.issueType}</dd></div>
                <div><dt>Status</dt><dd>{node.status}</dd></div>
                <div><dt>Assignee</dt><dd>{node.assignee || 'Unassigned'}</dd></div>
                <div><dt>Priority</dt><dd>{node.priority || 'Not set'}</dd></div>
                <div><dt>Project</dt><dd>{node.projectKey}</dd></div>
              </dl>
            </section>
          </>
        )}

        {node.type === 'note' && (
          <section className="designer-item-summary">
            <div className="detail-section-label">Note</div>
            <div className="designer-item-note">{node.content.trim() || 'This note is empty.'}</div>
          </section>
        )}

        {node.type === 'website' && (
          <section className="designer-item-summary">
            <div className="detail-section-label">Website address</div>
            <div className="designer-item-url">{node.url}</div>
          </section>
        )}
      </div>
    </div>
  );
}
