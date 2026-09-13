import type { ArtifactGadgetPayload } from '@praxis/core';
import { Icon } from '../../../ui/Icon';
import { GadgetActionBar, GadgetHeading } from '../controls';
import { payloadOf, type GadgetRendererProps } from '../gadgetContract';

function formatSize(bytes?: number): string | undefined {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Files a run produced.
 *
 * Paths are workspace-relative and validation has already refused any that
 * traverse out, so this only has to present them — opening one is an action
 * the host performs, never a link the renderer resolves itself.
 */
export function ArtifactGadget({ gadget, actionable, busy, onSubmit }: GadgetRendererProps) {
  const payload = payloadOf<'artifact'>(gadget) as ArtifactGadgetPayload;

  return (
    <>
      <GadgetHeading title={payload.title} id={`${gadget.gadgetId}-title`} />
      <ul className="gadget-artifacts">
        {payload.artifacts.map(artifact => {
          const size = formatSize(artifact.sizeBytes);
          return (
            <li key={artifact.path}>
              <Icon name="file" size={13} />
              <span className="gadget-artifact-body">
                <strong>{artifact.name}</strong>
                <code className="gadget-artifact-path">{artifact.path}</code>
                {artifact.description && <small>{artifact.description}</small>}
              </span>
              <span className="gadget-artifact-meta">
                {artifact.mediaType && <span>{artifact.mediaType}</span>}
                {size && <span>{size}</span>}
              </span>
            </li>
          );
        })}
      </ul>
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
