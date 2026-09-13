import type { TableGadgetPayload } from '@praxis/core';
import { GadgetActionBar, GadgetHeading, GadgetNote } from '../controls';
import { payloadOf, type GadgetRendererProps } from '../gadgetContract';

function renderCell(value: string | number | boolean | null) {
  if (value === null) return <span className="gadget-cell-empty">—</span>;
  if (typeof value === 'boolean') {
    return <span className={`gadget-cell-bool is-${value ? 'yes' : 'no'}`}>{value ? 'Yes' : 'No'}</span>;
  }
  return value;
}

/**
 * Bounded tabular evidence — check results, files, costs.
 *
 * Validation has already trimmed the rows to the contract's limit, so this
 * never guards against an unbounded payload; it only has to be honest about
 * the trim when one happened.
 */
export function TableGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'table'>(gadget) as TableGadgetPayload;
  const titleId = `${gadget.gadgetId}-title`;
  const empty = payload.rows.length === 0;

  return (
    <>
      {payload.title && <GadgetHeading title={payload.title} id={titleId} />}
      {empty ? (
        <p className="gadget-empty" data-testid="gadget-table-empty">
          {payload.emptyText ?? 'Nothing to show.'}
        </p>
      ) : (
        <div className="gadget-table-scroll">
          <table className="gadget-table" aria-labelledby={payload.title ? titleId : undefined}>
            {payload.caption && <caption>{payload.caption}</caption>}
            <thead>
              <tr>
                {payload.columns.map(column => (
                  <th key={column.key} scope="col" className={column.align === 'end' ? 'is-end' : undefined}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payload.rows.map((row, index) => (
                <tr key={index}>
                  {payload.columns.map(column => (
                    <td
                      key={column.key}
                      className={`${column.align === 'end' ? 'is-end' : ''}${column.mono ? ' is-mono' : ''}`.trim() || undefined}
                    >
                      {renderCell(row[column.key] ?? null)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {payload.truncated && (
        <GadgetNote testId="gadget-table-truncated">
          Some rows were left out to keep this readable.
        </GadgetNote>
      )}
      <GadgetActionBar
        actions={gadget.actions}
        actionable={actionable}
        busy={busy}
        valueFor={() => ({ kind: 'none' })}
        onSubmit={onSubmit}
      />
    </>
  );
}
