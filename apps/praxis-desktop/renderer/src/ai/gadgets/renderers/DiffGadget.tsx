import type { DiffGadgetPayload } from '@praxis/core';
import { Icon } from '../../../ui/Icon';
import { GadgetActionBar, GadgetHeading, GadgetNote } from '../controls';
import { payloadOf, type GadgetRendererProps } from '../gadgetContract';

const STATUS_ICON = {
  added: 'plus',
  modified: 'pencil',
  deleted: 'trash',
  renamed: 'arrow-right'
} as const;

/**
 * A change set, summarised.
 *
 * This is a *summary with a way in*, not a second diff viewer. The Changes
 * workspace already renders hunks, gutters, staging and conflict resolution;
 * duplicating any of that here would give the user two diff surfaces that
 * drift apart. The preview is capped by the contract, and `openInChangesRef`
 * hands off to the real thing.
 */
export function DiffGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'diff'>(gadget) as DiffGadgetPayload;
  const totals = payload.files.reduce(
    (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
    { additions: 0, deletions: 0 }
  );

  return (
    <>
      <GadgetHeading title={payload.title ?? 'Proposed changes'} detail={payload.summary} id={`${gadget.gadgetId}-title`} />
      <p className="gadget-diff-totals">
        <span>{payload.files.length} file{payload.files.length === 1 ? '' : 's'}</span>
        <span className="gadget-diff-add">+{totals.additions}</span>
        <span className="gadget-diff-del">−{totals.deletions}</span>
      </p>
      <ul className="gadget-diff-files">
        {payload.files.map(file => (
          <li key={file.path} className={`is-${file.status}`}>
            <span className="gadget-diff-file-head">
              <Icon name={STATUS_ICON[file.status]} size={12} />
              <code className="gadget-diff-path">
                {file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
              </code>
              <span className="gadget-diff-add">+{file.additions}</span>
              <span className="gadget-diff-del">−{file.deletions}</span>
            </span>
            {file.preview && <pre className="gadget-diff-preview">{file.preview}</pre>}
          </li>
        ))}
      </ul>
      {payload.truncated && <GadgetNote testId="gadget-diff-truncated">Some files were left out of this summary.</GadgetNote>}
      {payload.openInChangesRef && (
        <GadgetNote testId="gadget-diff-open-hint">
          Open the Changes workspace to review every hunk and stage them.
        </GadgetNote>
      )}
      <GadgetActionBar
        actions={gadget.actions}
        actionable={actionable}
        busy={busy}
        valueFor={action => ({ kind: 'confirmation', confirmed: action.effect !== 'informational' })}
        onSubmit={onSubmit}
      />
    </>
  );
}
