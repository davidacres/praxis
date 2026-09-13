import type { ChartGadgetPayload } from '@praxis/core';
import { GadgetActionBar, GadgetHeading } from '../controls';
import { payloadOf, type GadgetRendererProps } from '../gadgetContract';

/** Series colours come from the theme's project palette so charts follow the accent ramp. */
const SERIES_TOKENS = [
  'var(--accent)',
  'var(--project-color-aqua)',
  'var(--project-color-violet)',
  'var(--project-color-orange)',
  'var(--project-color-green)',
  'var(--project-color-magenta)',
  'var(--project-color-blue)',
  'var(--project-color-yellow)'
];

/**
 * A small inline plot, drawn as plain SVG.
 *
 * Deliberately not a charting library: a gadget renders bounded, already-summarised
 * numbers, and pulling in a chart dependency for a bar and a line would cost more
 * than it returns. The table underneath is not a fallback — it is the accessible
 * representation, always present, because an SVG of a trend line is unreadable to
 * a screen reader no matter how it is labelled.
 */
export function ChartGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'chart'>(gadget) as ChartGadgetPayload;
  const titleId = `${gadget.gadgetId}-title`;

  const allPoints = payload.series.flatMap(series => series.points);
  const values = allPoints.map(point => point.y);
  const maxValue = values.length ? Math.max(...values, 0) : 0;
  const minValue = values.length ? Math.min(...values, 0) : 0;
  const span = maxValue - minValue || 1;
  const longest = Math.max(...payload.series.map(series => series.points.length), 1);

  const width = 480;
  const height = 140;
  const padding = { top: 8, right: 8, bottom: 8, left: 8 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const xFor = (index: number) => padding.left + (longest === 1 ? plotWidth / 2 : (index / (longest - 1)) * plotWidth);
  const yFor = (value: number) => padding.top + plotHeight - ((value - minValue) / span) * plotHeight;

  return (
    <>
      {payload.title && <GadgetHeading title={payload.title} id={titleId} />}
      <div className="gadget-chart">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="gadget-chart-svg"
          role="img"
          aria-label={payload.summary ?? `${payload.chartKind} chart of ${payload.series.map(s => s.label).join(', ')}`}
        >
          {payload.chartKind === 'line'
            ? payload.series.map((series, seriesIndex) => (
                <polyline
                  key={series.label}
                  fill="none"
                  stroke={SERIES_TOKENS[seriesIndex % SERIES_TOKENS.length]}
                  strokeWidth={1.5}
                  points={series.points.map((point, index) => `${xFor(index)},${yFor(point.y)}`).join(' ')}
                />
              ))
            : payload.series.map((series, seriesIndex) => {
                const barWidth = Math.max(2, plotWidth / (longest * payload.series.length + 1) - 2);
                return series.points.map((point, index) => (
                  <rect
                    key={`${series.label}-${index}`}
                    x={xFor(index) + seriesIndex * barWidth - (payload.series.length * barWidth) / 2}
                    y={Math.min(yFor(point.y), yFor(0))}
                    width={barWidth}
                    height={Math.max(1, Math.abs(yFor(point.y) - yFor(0)))}
                    fill={SERIES_TOKENS[seriesIndex % SERIES_TOKENS.length]}
                  />
                ));
              })}
        </svg>
        {payload.series.length > 1 && (
          <ul className="gadget-chart-legend">
            {payload.series.map((series, index) => (
              <li key={series.label}>
                <span className="gadget-chart-swatch" style={{ background: SERIES_TOKENS[index % SERIES_TOKENS.length] }} />
                {series.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* The numbers, for anyone who cannot use the picture. */}
      <details className="gadget-chart-data">
        <summary>Chart data</summary>
        <table className="gadget-table">
          <thead>
            <tr>
              <th scope="col">{payload.xLabel ?? 'Point'}</th>
              {payload.series.map(series => (
                <th scope="col" key={series.label} className="is-end">
                  {series.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: longest }, (_, index) => (
              <tr key={index}>
                <th scope="row">{String(payload.series[0]?.points[index]?.x ?? index + 1)}</th>
                {payload.series.map(series => (
                  <td key={series.label} className="is-end is-mono">
                    {series.points[index]?.y ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {payload.summary && <p className="gadget-detail">{payload.summary}</p>}
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
