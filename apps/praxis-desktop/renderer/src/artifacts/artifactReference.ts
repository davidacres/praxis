import type { ArtifactLibraryItem } from '@praxis/core';
import type { SessionContextReference } from '../ai/sessionContext';

/** Text files up to this size travel inline; larger ones, and pictures, travel as a path. */
const INLINE_TEXT_BYTES = 64 * 1024;
/** Keeps a large group from swamping the session's context. */
const MAX_REFERENCE_CHARS = 200_000;

/** What the dialog is adding: one artifact, or a group of them. */
export type ArtifactSendTarget =
  | { kind: 'artifact'; item: ArtifactLibraryItem }
  | { kind: 'group'; groupId: string; name: string; items: ArtifactLibraryItem[] };

/**
 * Snapshots artifacts into a context reference. Each one names its file — by
 * repository path and absolute path, so an agent with file tools can open it —
 * and small text files carry their content inline. The snapshot is taken now;
 * later edits to the files don't change what the session receives.
 */
export async function artifactReference(
  projectId: string,
  root: string | undefined,
  target: ArtifactSendTarget,
  readText: (projectId: string, path: string) => Promise<string>
): Promise<SessionContextReference> {
  const items = target.kind === 'artifact' ? [target.item] : target.items;
  const sections: string[] = [];
  let budget = MAX_REFERENCE_CHARS;
  for (const item of items) {
    const lines = [
      `## ${item.title}`,
      `Path: ${item.path}`,
      ...(root ? [`Absolute path: ${root.replace(/\/$/, '')}/${item.path}`] : []),
      ...(item.description ? [`Description: ${item.description}`] : [])
    ];
    const inline = (item.kind === 'document' || item.kind === 'data' || item.kind === 'page') && item.sizeBytes <= INLINE_TEXT_BYTES;
    if (inline && budget > 0) {
      try {
        const text = (await readText(projectId, item.path)).slice(0, budget);
        budget -= text.length;
        lines.push('', '```', text, '```');
      } catch (error) {
        lines.push(`(Could not read the file: ${error instanceof Error ? error.message : String(error)})`);
      }
    } else {
      lines.push(item.kind === 'image' ? '(A picture — open it from the path above.)' : '(Not included inline — open it from the path above.)');
    }
    sections.push(lines.join('\n'));
  }

  const capturedAt = new Date().toISOString();
  if (target.kind === 'artifact') {
    return {
      id: `artifact:${target.item.path}@${capturedAt}`,
      kind: 'artifact',
      label: `Artifact: ${target.item.title}`,
      content: sections.join('\n\n'),
      capturedAt
    };
  }
  const count = items.length;
  return {
    id: `artifact-group:${target.groupId}@${capturedAt}`,
    kind: 'artifact-group',
    label: `Artifacts: ${target.name} (${count} ${count === 1 ? 'file' : 'files'})`,
    content: sections.join('\n\n---\n\n'),
    capturedAt
  };
}
