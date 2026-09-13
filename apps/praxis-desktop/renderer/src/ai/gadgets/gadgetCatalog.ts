import type { GadgetKind } from '@praxis/core';
import type { IconName } from '../../ui/Icon';

/**
 * The user-facing catalogue of surfaces Praxis can render.
 *
 * Keep this data browser-safe and separate from the renderer registry: the
 * Settings page needs to explain a gadget even when it has not appeared in a
 * conversation yet. Tool completion is host-owned, so it is listed alongside
 * the provider-supplied ChatBlock gadgets without pretending it is a model
 * action kind.
 */
export interface GadgetCatalogEntry {
  id: GadgetKind | 'tool-completion';
  name: string;
  purpose: string;
  icon: IconName;
}

export const BUILT_IN_GADGET_CATALOG: readonly GadgetCatalogEntry[] = [
  {
    id: 'tool-completion',
    name: 'Tool completion',
    purpose: 'Groups each tool run into one expandable activity entry, showing its result without repeating the started and completed rows.',
    icon: 'tools'
  },
  {
    id: 'choice',
    name: 'Choice',
    purpose: 'Lets you choose one or more options when the agent needs a clear decision.',
    icon: 'list'
  },
  {
    id: 'confirmation',
    name: 'Confirmation',
    purpose: 'Explains a proposed change and asks you to confirm or decline it.',
    icon: 'check-square'
  },
  {
    id: 'form',
    name: 'Form',
    purpose: 'Collects several typed values together before the agent continues.',
    icon: 'pencil'
  },
  {
    id: 'table',
    name: 'Table',
    purpose: 'Presents structured rows for inspecting results, checks, or other evidence.',
    icon: 'columns'
  },
  {
    id: 'chart',
    name: 'Chart',
    purpose: 'Shows a small accessible bar or line chart with its underlying data.',
    icon: 'graph'
  },
  {
    id: 'progress',
    name: 'Progress',
    purpose: 'Summarises a running, blocked, succeeded, failed, or cancelled operation.',
    icon: 'zap'
  },
  {
    id: 'diff',
    name: 'Diff',
    purpose: 'Previews bounded file changes and links the full review to the Changes workspace.',
    icon: 'git-branch'
  },
  {
    id: 'artifact',
    name: 'Artifact',
    purpose: 'Lists workspace artifacts produced by a task with safe paths and metadata.',
    icon: 'package'
  },
  {
    id: 'handoff',
    name: 'Handoff',
    purpose: 'Makes provider-to-provider context transfer reviewable before it happens.',
    icon: 'arrow-right'
  },
  {
    id: 'conflict',
    name: 'Conflict',
    purpose: 'Presents competing sides and requires an explicit resolution for each conflict.',
    icon: 'warning'
  },
  {
    id: 'approval',
    name: 'Approval',
    purpose: 'Identifies the workflow gate, requester, and evidence behind an approval request.',
    icon: 'shield'
  }
];
