/**
 * Canned data for the app's demo mode — enough to exercise every screen with no
 * desktop host running. The real transport (`@praxis/mobile-protocol` Noise IK
 * over a LAN socket) replaces this; the shapes match what the host's
 * `MobileHostReads` return.
 */
import type { MobileAttentionItem } from '../renderer/mobileAttention';
import type { MobileFollowUp } from '../renderer/mobileFollowUp';

export const DEMO_HOST = { hostId: 'dave-mac', hostName: "Dave's Mac", online: true };
export const DEMO_PROJECT = { projectId: 'praxis', name: 'Praxis', workflow: 'Plan → Implement → Review → Approve' };

export interface DemoWorkItem {
  workId: string;
  title: string;
  status: string;
  sessionId: string;
  runId?: string;
}

export const DEMO_WORK: DemoWorkItem[] = [
  { workId: 'FX-BE-081', title: 'Read and continue existing work from the phone', status: 'In Progress', sessionId: 'sess-81', runId: 'run-81' },
  { workId: 'FX-BE-077', title: 'Discovery and resilient local transport', status: 'In Progress', sessionId: 'sess-77' },
  { workId: 'FX-BE-035', title: 'Real GitHub backend, modeled on folder', status: 'Done', sessionId: 'sess-35' },
];

export const DEMO_TRANSCRIPTS: Record<string, string[]> = {
  'sess-81': [
    'Planned the work list and session restoration against the host reads.',
    'Wired the Work screen to the navigation reducer; detail tabs are Chat / Progress / Changes.',
  ],
  'sess-77': ['Noise IK channel validated against the snow vectors; LAN listener authorises each peer.'],
  'sess-35': ['Shipped GitHubBoardService; columns synthesize from status labels.'],
};

export const DEMO_RUN = {
  runId: 'run-81',
  workflowName: 'Governed delivery',
  status: 'awaiting-approval' as const,
  stages: [
    { nodeId: 'plan', name: 'Plan', outcome: 'succeeded' as const },
    { nodeId: 'implement', name: 'Implement', outcome: 'succeeded' as const },
    { nodeId: 'review', name: 'Review', outcome: 'succeeded' as const },
    { nodeId: 'qa', name: 'QA', outcome: 'succeeded' as const },
    { nodeId: 'approve', name: 'Approve', outcome: 'awaiting' as const },
  ],
  changes: [
    { path: 'apps/praxis-mobile/App.tsx', added: 96, removed: 0 },
    { path: 'apps/praxis-mobile/screens/WorkScreen.tsx', added: 140, removed: 0 },
  ],
};

export const DEMO_ATTENTION: MobileAttentionItem[] = [
  { id: 'approval:run-81', kind: 'approval', hostId: DEMO_HOST.hostId, projectId: DEMO_PROJECT.projectId, runId: 'run-81', createdAt: '2026-09-10T05:00:00.000Z', resolved: false },
];

export const DEMO_FOLLOWUPS: MobileFollowUp[] = [];

export const DEMO_ACTIVITY = [
  { at: '05:12', text: 'Review stage succeeded on run-81.' },
  { at: '05:10', text: 'QA stage succeeded on run-81.' },
  { at: '04:58', text: 'Implement committed the snapshot for run-81.' },
];
