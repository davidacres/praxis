/**
 * The app's single store: the shell/navigation state from the tested reducers
 * (`renderer/mobileShellState`, `renderer/mobileNavigation`) plus the work,
 * attention and follow-up state a screen reads. Demo mode fills it from
 * `demoData`; a real session replaces `connect()` with the Noise transport.
 */
import React, { createContext, useContext, useMemo, useState } from 'react';
import {
  createMobileShellState,
  setMobileShellConnection,
  type MobileShellState,
} from '../renderer/mobileShellState';
import {
  MOBILE_PRIMARY_ROUTES,
  selectMobileDetail,
  selectMobileRoute,
  type MobileDetailTab,
  type MobileNavigationState,
  type MobilePrimaryRoute,
} from '../renderer/mobileNavigation';
import { addFollowUp, updateFollowUp, type MobileFollowUp } from '../renderer/mobileFollowUp';
import { openMobileAttention, type MobileAttentionItem } from '../renderer/mobileAttention';
import {
  DEMO_ATTENTION,
  DEMO_FOLLOWUPS,
  DEMO_HOST,
  DEMO_PROJECT,
  DEMO_TRANSCRIPTS,
  DEMO_WORK,
  type DemoWorkItem,
} from './demoData';

export { MOBILE_PRIMARY_ROUTES };
export type { MobilePrimaryRoute, MobileDetailTab };

interface Store {
  shell: MobileShellState;
  host: typeof DEMO_HOST;
  project: typeof DEMO_PROJECT;
  work: DemoWorkItem[];
  attention: MobileAttentionItem[];
  followUps: MobileFollowUp[];
  openWorkId: string | undefined;

  connect(): void;
  disconnect(): void;
  setRoute(primary: MobilePrimaryRoute): void;
  setDetail(detail: MobileDetailTab): void;
  openWork(workId: string | undefined): void;
  transcriptFor(sessionId: string): string[];
  sendFollowUp(work: DemoWorkItem, text: string): void;
  approve(runId: string): void;
}

const StoreContext = createContext<Store | undefined>(undefined);

export function StoreProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [shell, setShell] = useState<MobileShellState>(() => createMobileShellState());
  const [work, setWork] = useState<DemoWorkItem[]>([]);
  const [attention, setAttention] = useState<MobileAttentionItem[]>([]);
  const [followUps, setFollowUps] = useState<MobileFollowUp[]>(DEMO_FOLLOWUPS);
  const [openWorkId, setOpenWorkId] = useState<string | undefined>(undefined);

  const value = useMemo<Store>(() => {
    const nav = (mutate: (state: MobileNavigationState) => MobileNavigationState): void =>
      setShell(previous => ({ ...previous, navigation: mutate(previous.navigation) }));

    return {
      shell,
      host: DEMO_HOST,
      project: DEMO_PROJECT,
      work,
      attention,
      followUps,
      openWorkId,

      connect: () => {
        setShell(previous => setMobileShellConnection(previous, 'connecting'));
        setTimeout(() => {
          setWork(DEMO_WORK);
          setAttention(DEMO_ATTENTION);
          setShell(previous => ({
            ...setMobileShellConnection(previous, 'ready'),
            navigation: { ...previous.navigation, hostId: DEMO_HOST.hostId, projectId: DEMO_PROJECT.projectId },
          }));
        }, 350);
      },
      disconnect: () => {
        setShell(createMobileShellState());
        setWork([]);
        setAttention([]);
        setOpenWorkId(undefined);
      },
      setRoute: primary => nav(state => selectMobileRoute(state, primary)),
      setDetail: detail => nav(state => selectMobileDetail(state, detail)),
      openWork: workId => setOpenWorkId(workId),
      transcriptFor: sessionId => DEMO_TRANSCRIPTS[sessionId] ?? [],
      sendFollowUp: (item, text) => {
        const messageId = `m-${Date.now()}`;
        setFollowUps(list =>
          addFollowUp(list, {
            messageId,
            hostId: DEMO_HOST.hostId,
            projectId: DEMO_PROJECT.projectId,
            sessionId: item.sessionId,
            workId: item.workId,
            text,
            state: 'pending',
            createdAt: new Date().toISOString(),
          }) as MobileFollowUp[],
        );
        setTimeout(() => {
          setFollowUps(list => updateFollowUp(list, messageId, 'completed', 'Acknowledged by the host.') as MobileFollowUp[]);
        }, 600);
      },
      approve: runId => {
        setAttention(list => list.map(entry => (entry.runId === runId ? { ...entry, resolved: true } : entry)));
        setWork(list => list.map(entry => (entry.runId === runId ? { ...entry, status: 'Approved' } : entry)));
      },
    };
  }, [shell, work, attention, followUps, openWorkId]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside <StoreProvider>.');
  return store;
}

export function useOpenAttention(): readonly MobileAttentionItem[] {
  const { attention, host, project } = useStore();
  return openMobileAttention(attention, { hostId: host.hostId, projectId: project.projectId });
}
