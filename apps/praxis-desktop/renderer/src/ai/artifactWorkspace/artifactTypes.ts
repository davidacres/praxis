export interface ActiveArtifact {
  name: string;
  path: string;
  mediaType?: string;
  sizeBytes?: number;
  description?: string;
  category?: 'deliverable' | 'evidence' | 'report' | 'diff' | 'log';
  verdict?: 'passed' | 'failed' | 'needs-review';
  content?: string;
  language?: string;
  version?: number;
  identifier?: string;
  sessionId?: string;
}

export type ArtifactViewMode = 'preview' | 'code' | 'diff';

export type ArtifactLayoutPrototype =
  | 'classic-split'
  | 'dual-pane'
  | 'tabbed-studio'
  | 'device-canvas'
  | 'iterative-companion';

export interface ArtifactLayoutMeta {
  id: ArtifactLayoutPrototype;
  name: string;
  shortDesc: string;
  icon: string;
  badge?: string;
}

export const ARTIFACT_LAYOUT_PROTOTYPES: ArtifactLayoutMeta[] = [
  {
    id: 'classic-split',
    name: 'Classic Split',
    shortDesc: 'Side-by-side dock with segmented Preview/Code/Diff tabs',
    icon: 'split-horizontal',
    badge: 'Default'
  },
  {
    id: 'dual-pane',
    name: 'Dual-Pane Workbench',
    shortDesc: 'Simultaneous live preview & syntax editor with live compile sync',
    icon: 'columns',
    badge: 'Pro'
  },
  {
    id: 'tabbed-studio',
    name: 'Multi-Tab Studio',
    shortDesc: 'Multi-file workbench with asset drawer & batch workspace actions',
    icon: 'folder-open'
  },
  {
    id: 'device-canvas',
    name: 'Device Viewport Stage',
    shortDesc: 'Responsive mobile/tablet/desktop bezels with inspector console',
    icon: 'globe'
  },
  {
    id: 'iterative-companion',
    name: 'Iterative Companion',
    shortDesc: 'Live canvas with embedded revision gutter and version stepper',
    icon: 'sparkles',
    badge: 'AI'
  }
];

