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
