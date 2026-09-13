/**
 * Plain-text rendering of a gadget (TASK-277).
 *
 * Every gadget must be representable as text, for three separate readers: an
 * older client that has no renderer for the kind, a transcript or log export,
 * and a screen reader falling back when a visual surface fails. A producer
 * normally supplies `fallbackText` itself; this is what fills the gap when it
 * did not, and it is deliberately complete rather than a one-line summary —
 * a fallback that says "a table" instead of the numbers is not a fallback.
 */
import type {
  AnyGadgetEnvelope,
  ChoiceGadgetPayload,
  ConfirmationGadgetPayload,
  ApprovalGadgetPayload,
  ArtifactGadgetPayload,
  ChartGadgetPayload,
  ConflictGadgetPayload,
  DiffGadgetPayload,
  FormGadgetPayload,
  HandoffGadgetPayload,
  ProgressGadgetPayload,
  TableGadgetPayload
} from './contracts';

function bullet(lines: (string | undefined)[]): string {
  return lines.filter((line): line is string => Boolean(line && line.trim())).map(line => `- ${line}`).join('\n');
}

function section(title: string | undefined, body: string): string {
  return title ? `${title}\n\n${body}` : body;
}

function formatCell(value: string | number | boolean | null): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

/** Render a table as aligned columns so it stays readable in a monospace log. */
function renderTable(payload: TableGadgetPayload): string {
  if (payload.rows.length === 0) return payload.emptyText ?? 'No rows.';
  const header = payload.columns.map(column => column.label);
  const body = payload.rows.map(row => payload.columns.map(column => formatCell(row[column.key] ?? null)));
  const widths = header.map((label, index) => Math.max(label.length, ...body.map(row => row[index].length)));
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd();
  return [line(header), widths.map(width => '-'.repeat(width)).join('  '), ...body.map(line)].join('\n');
}

export function gadgetFallbackText(envelope: AnyGadgetEnvelope): string {
  switch (envelope.kind) {
    case 'choice': {
      const payload = envelope.payload as ChoiceGadgetPayload;
      return section(
        payload.question,
        bullet(payload.options.map(option => {
          const suffix = option.disabledReason ? ` (unavailable: ${option.disabledReason})` : '';
          return `${option.label}${option.description ? ` — ${option.description}` : ''}${suffix}`;
        }))
      );
    }

    case 'confirmation': {
      const payload = envelope.payload as ConfirmationGadgetPayload;
      const parts = [payload.question];
      if (payload.detail) parts.push(payload.detail);
      if (payload.consequences?.length) parts.push(`This will:\n${bullet(payload.consequences)}`);
      return parts.join('\n\n');
    }

    case 'form': {
      const payload = envelope.payload as FormGadgetPayload;
      return section(
        payload.title,
        bullet(payload.fields.map(field => `${field.label}${field.required ? ' (required)' : ''} — ${field.type}`))
      );
    }

    case 'table': {
      const payload = envelope.payload as TableGadgetPayload;
      const body = renderTable(payload);
      const notes = [payload.caption, payload.truncated ? 'Some rows were omitted.' : undefined]
        .filter(Boolean)
        .join(' ');
      return [section(payload.title, body), notes].filter(Boolean).join('\n\n');
    }

    case 'chart': {
      const payload = envelope.payload as ChartGadgetPayload;
      // A chart's fallback is its numbers. Series are listed with their range
      // so the shape survives even without a plot.
      const lines = payload.series.map(series => {
        const values = series.points.map(point => point.y);
        const min = Math.min(...values);
        const max = Math.max(...values);
        const last = values[values.length - 1];
        return `${series.label}: ${series.points.length} points, min ${min}, max ${max}, last ${last}`;
      });
      return [section(payload.title, bullet(lines)), payload.summary].filter(Boolean).join('\n\n');
    }

    case 'progress': {
      const payload = envelope.payload as ProgressGadgetPayload;
      const headline = `${payload.title} — ${payload.status}${payload.percent !== undefined ? ` (${payload.percent}%)` : ''}`;
      const steps = payload.steps?.length ? bullet(payload.steps.map(step => `${step.label}: ${step.state}`)) : undefined;
      return [headline, payload.detail, steps].filter(Boolean).join('\n\n');
    }

    case 'diff': {
      const payload = envelope.payload as DiffGadgetPayload;
      const files = bullet(payload.files.map(file => `${file.status} ${file.path} (+${file.additions}/-${file.deletions})`));
      const notes = payload.truncated ? 'Some files were omitted.' : undefined;
      return [section(payload.title, files), payload.summary, notes].filter(Boolean).join('\n\n');
    }

    case 'artifact': {
      const payload = envelope.payload as ArtifactGadgetPayload;
      return section(
        payload.title,
        bullet(payload.artifacts.map(artifact => `${artifact.name} — ${artifact.path}${artifact.description ? ` (${artifact.description})` : ''}`))
      );
    }

    case 'handoff': {
      const payload = envelope.payload as HandoffGadgetPayload;
      const parts = [`${payload.title}: ${payload.fromProvider} → ${payload.toProvider}`, payload.contextSummary];
      if (payload.includedItems?.length) parts.push(`Included:\n${bullet(payload.includedItems.map(item => item.label))}`);
      if (payload.excludedItems?.length) {
        parts.push(`Not included:\n${bullet(payload.excludedItems.map(item => (item.reason ? `${item.label} — ${item.reason}` : item.label)))}`);
      }
      if (payload.warning) parts.push(payload.warning);
      return parts.join('\n\n');
    }

    case 'conflict': {
      const payload = envelope.payload as ConflictGadgetPayload;
      const body = payload.conflicts
        .map(conflict => `${conflict.label}${conflict.path ? ` (${conflict.path})` : ''}\n  ours:   ${conflict.ours}\n  theirs: ${conflict.theirs}`)
        .join('\n\n');
      return [section(payload.title, body), payload.description].filter(Boolean).join('\n\n');
    }

    case 'approval': {
      const payload = envelope.payload as ApprovalGadgetPayload;
      const parts = [payload.title, payload.summary, `Gate: ${payload.gate}`];
      if (payload.effect) parts.push(`Approving will: ${payload.effect}`);
      if (payload.evidence?.length) parts.push(bullet(payload.evidence.map(entry => `${entry.label}: ${entry.value}`)));
      return parts.filter(Boolean).join('\n\n');
    }

    default: {
      // Unreachable for known kinds, but an envelope that arrived from a newer
      // producer can land here — say so plainly instead of rendering nothing.
      const unknown = envelope as AnyGadgetEnvelope;
      return `An interactive "${unknown.kind}" surface this client cannot display.`;
    }
  }
}

/** Append the available actions, for a reader who must respond in prose. */
export function gadgetFallbackWithActions(envelope: AnyGadgetEnvelope): string {
  const text = envelope.fallbackText?.trim() || gadgetFallbackText(envelope);
  if (envelope.actions.length === 0) return text;
  const actions = envelope.actions.map(action => `${action.label}${action.danger ? ' (destructive)' : ''}`).join(' · ');
  return `${text}\n\nAvailable: ${actions}`;
}
