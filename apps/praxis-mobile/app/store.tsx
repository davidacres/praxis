import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MobileCaller,
  MobileCommand,
  MobileEventEnvelope,
  MobileReadRequest,
  MobileSessionEvent,
  MobileSessionSnapshot,
  MobileSessionSummary,
} from '@praxis/core';
import {
  createMobileShellState,
  setMobileShellConnection,
  setMobileShellError,
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
import { DEMO_HOST, DEMO_PROJECT, type DemoTranscriptMessage, type DemoWorkItem } from './demoData';
import { NativeMobileConnection, saveMobileHostConfiguration, type MobileHostConfiguration } from './mobileConnection';

export { MOBILE_PRIMARY_ROUTES };
export type { MobilePrimaryRoute, MobileDetailTab };

interface MobileHostSummary { hostId: string; hostName: string; online: boolean }
interface MobileProjectSummary { projectId: string; name: string; workflow?: string }
export interface MobileWorkflowChoice { workflowId: string; name: string; trigger: string }
export interface MobileRunSummary {
  runId: string;
  workflowName: string;
  status: string;
  explanation: string;
  stages: Array<{
    nodeId: string;
    name: string;
    outcome: string;
    lane: string;
    artifacts: Array<{ contractId: string; kind: string; path?: string }>;
  }>;
}
interface DraftWorkItem extends DemoWorkItem { draft?: boolean; provider?: string; model?: string }

interface Store {
  shell: MobileShellState;
  host: MobileHostSummary;
  project: MobileProjectSummary;
  work: DraftWorkItem[];
  attention: MobileAttentionItem[];
  followUps: MobileFollowUp[];
  workflows: MobileWorkflowChoice[];
  runs: Record<string, MobileRunSummary>;
  openWorkId: string | undefined;
  connectionError: string | undefined;

  connect(config: MobileHostConfiguration): Promise<void>;
  disconnect(): void;
  setRoute(primary: MobilePrimaryRoute): void;
  setDetail(detail: MobileDetailTab): void;
  openWork(workId: string | undefined): void;
  startNewChat(): void;
  transcriptFor(sessionId: string): DemoTranscriptMessage[];
  sendFollowUp(work: DraftWorkItem, text: string): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  respondToPermission(requestId: string, decision: 'allow' | 'deny'): Promise<void>;
  startWorkflow(workflowId: string, task: string): Promise<void>;
  approve(runId: string): Promise<void>;
  loadRun(runId: string): Promise<void>;
}

const StoreContext = createContext<Store | undefined>(undefined);
const caller: MobileCaller = { deviceId: 'praxis-mobile', capabilities: ['view', 'execute', 'approve'] };

function commandId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function workFromSession(session: MobileSessionSummary): DraftWorkItem {
  return {
    workId: session.sessionKey,
    title: session.title,
    status: session.lifecycle,
    sessionId: session.sessionId,
    ...(session.provider ? { provider: session.provider } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.runId ? { runId: session.runId } : {}),
  };
}

function transcript(snapshot: MobileSessionSnapshot | undefined): DemoTranscriptMessage[] {
  if (!snapshot) return [];
  return snapshot.messages
    .filter(message => message.role !== 'system')
    .map(message => ({
      id: message.id,
      author: message.role === 'user' ? 'user' : 'assistant',
      text: message.text,
      at: new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }));
}

export function StoreProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [shell, setShell] = useState<MobileShellState>(() => createMobileShellState());
  const [host, setHost] = useState<MobileHostSummary>(DEMO_HOST);
  const [project, setProject] = useState<MobileProjectSummary>(DEMO_PROJECT);
  const [work, setWork] = useState<DraftWorkItem[]>([]);
  const [snapshots, setSnapshots] = useState<Record<string, MobileSessionSnapshot>>({});
  const [attention, setAttention] = useState<MobileAttentionItem[]>([]);
  const [followUps, setFollowUps] = useState<MobileFollowUp[]>([]);
  const [workflows, setWorkflows] = useState<MobileWorkflowChoice[]>([]);
  const [runs, setRuns] = useState<Record<string, MobileRunSummary>>({});
  const [openWorkId, setOpenWorkId] = useState<string | undefined>(undefined);
  const [connectionError, setConnectionError] = useState<string | undefined>(undefined);
  const connectionRef = useRef<NativeMobileConnection | undefined>(undefined);
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const stateUnsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const projectRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (shell.connection !== 'ready') return;
    const refresh = (): void => {
      const connection = connectionRef.current;
      const projectId = projectRef.current;
      if (!connection || !projectId) return;
      void connection.read<MobileAttentionItem[]>({
        protocolVersion: 1,
        requestId: commandId('attention'),
        caller,
        target: { hostId: connection.config.hostId, projectId },
        operation: 'attention.list',
      }).then(setAttention).catch(() => undefined);
    };
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [shell.connection]);

  const value = useMemo<Store>(() => {
    const nav = (mutate: (state: MobileNavigationState) => MobileNavigationState): void =>
      setShell(previous => ({ ...previous, navigation: mutate(previous.navigation) }));

    const target = (extra: Record<string, string | undefined> = {}) => ({
      hostId: host.hostId,
      ...(projectRef.current ? { projectId: projectRef.current } : {}),
      ...extra,
    });

    const applySnapshot = (snapshot: MobileSessionSnapshot): void => {
      setSnapshots(previous => ({ ...previous, [snapshot.sessionId]: snapshot }));
      setWork(previous => {
        const next = workFromSession(snapshot);
        const index = previous.findIndex(item => item.sessionId === snapshot.sessionId || item.workId === snapshot.sessionKey);
        if (index < 0) return [next, ...previous];
        const copy = [...previous];
        copy[index] = next;
        return copy;
      });
    };

    return {
      shell,
      host,
      project,
      work,
      attention,
      followUps,
      workflows,
      runs,
      openWorkId,
      connectionError,

      connect: async config => {
        unsubscribeRef.current?.();
        connectionRef.current?.close();
        setConnectionError(undefined);
        setShell(previous => setMobileShellConnection(previous, 'connecting'));
        const connection = new NativeMobileConnection(config);
        connectionRef.current = connection;
        stateUnsubscribeRef.current = connection.subscribeState((connected, error) => {
          if (connected || connectionRef.current !== connection) return;
          setConnectionError(error?.message ?? 'The Praxis desktop connection closed.');
          setShell(previous => setMobileShellError(previous, error?.message ?? 'The Praxis desktop connection closed.'));
        });
        try {
          await saveMobileHostConfiguration(config);
          await connection.connect();
          const hostSummary: MobileHostSummary = {
            hostId: config.hostId,
            hostName: config.hostName?.trim() || config.address,
            online: true,
          };
          setHost(hostSummary);

          let projectSummary: MobileProjectSummary;
          if (config.projectId) {
            projectSummary = await connection.read<MobileProjectSummary>({
                protocolVersion: 1,
                requestId: commandId('project'),
                caller,
                target: { hostId: config.hostId, projectId: config.projectId },
                operation: 'projects.snapshot',
              });
          } else {
            const available = await connection.read<{ projects: MobileProjectSummary[] }>({
              protocolVersion: 1,
              requestId: commandId('projects'),
              caller,
              target: { hostId: config.hostId },
              operation: 'projects.snapshot',
            });
            const first = available.projects[0];
            if (!first) throw new Error('This phone has not been granted access to a project.');
            projectSummary = first;
          }
          const projectId = projectSummary.projectId;
          projectRef.current = projectId;
          setProject(projectSummary);
          await saveMobileHostConfiguration({ ...config, projectId });

          const sessions = await connection.read<readonly MobileSessionSummary[]>({
            protocolVersion: 1,
            requestId: commandId('sessions'),
            caller,
            target: { hostId: config.hostId, projectId },
            operation: 'sessions.list',
          });
          setWork(sessions.filter(session => !session.archived).map(workFromSession));
          setOpenWorkId(sessions.find(session => !session.archived)?.sessionKey);

          const loaded = await Promise.all(sessions.filter(session => !session.archived).map(session =>
            connection.read<MobileSessionSnapshot>({
              protocolVersion: 1,
              requestId: commandId('session'),
              caller,
              target: { hostId: config.hostId, projectId, sessionId: session.sessionId },
              operation: 'sessions.get',
            }),
          ));
          setSnapshots(Object.fromEntries(loaded.map(snapshot => [snapshot.sessionId, snapshot])));

          const choices = await connection.read<MobileWorkflowChoice[]>({
              protocolVersion: 1,
              requestId: commandId('workflows'),
              caller,
              target: { hostId: config.hostId, projectId },
              operation: 'workflows.list',
            });
          setWorkflows(choices.filter(choice => choice.trigger !== 'ticket'));
          const items = await connection.read<MobileAttentionItem[]>({
              protocolVersion: 1,
              requestId: commandId('attention'),
              caller,
              target: { hostId: config.hostId, projectId },
              operation: 'attention.list',
            });
          setAttention(items);

          unsubscribeRef.current = connection.subscribe((envelope: MobileEventEnvelope) => {
            const event = envelope.event as MobileSessionEvent;
            if (event.type === 'session.snapshot') {
              applySnapshot(event.snapshot);
              const snapshot = event.snapshot;
              if (snapshot.projectId) {
                setAttention(previous => [
                  ...previous.filter(item => item.kind !== 'permission' || item.sessionId !== snapshot.sessionId),
                  ...snapshot.pendingPermissions.map(permission => ({
                    id: `permission:${permission.requestId}`,
                    kind: 'permission' as const,
                    hostId: config.hostId,
                    projectId: snapshot.projectId!,
                    sessionId: snapshot.sessionId,
                    requestId: permission.requestId,
                    summary: permission.summary,
                    ...(permission.detail ? { detail: permission.detail } : {}),
                    createdAt: permission.createdAt,
                    resolved: false,
                  })),
                ]);
              }
            }
            if (event.type === 'session.removed') {
              setWork(previous => previous.filter(item => item.sessionId !== event.sessionId));
              setSnapshots(previous => {
                const next = { ...previous };
                delete next[event.sessionId];
                return next;
              });
            }
          });
          await connection.replay(0);
          setShell(previous => ({
            ...setMobileShellConnection(previous, 'ready'),
            navigation: {
              ...previous.navigation,
              hostId: config.hostId,
              projectId,
            },
          }));
        } catch (error) {
          connection.close();
          setConnectionError(error instanceof Error ? error.message : String(error));
          setShell(previous => setMobileShellError(previous, error instanceof Error ? error.message : String(error)));
        }
      },
      disconnect: () => {
        unsubscribeRef.current?.();
        stateUnsubscribeRef.current?.();
        connectionRef.current?.close();
        connectionRef.current = undefined;
        projectRef.current = undefined;
        setShell(createMobileShellState());
        setWork([]);
        setSnapshots({});
        setAttention([]);
        setWorkflows([]);
        setRuns({});
        setOpenWorkId(undefined);
      },
      setRoute: primary => nav(state => selectMobileRoute(state, primary)),
      setDetail: detail => nav(state => selectMobileDetail(state, detail)),
      openWork: workId => setOpenWorkId(workId),
      startNewChat: () => {
        const id = `draft-${Date.now().toString(36)}`;
        const item: DraftWorkItem = { workId: id, title: 'New chat', status: 'idle', sessionId: id, draft: true };
        setWork(list => [item, ...list]);
        setOpenWorkId(item.workId);
        nav(state => selectMobileDetail(selectMobileRoute(state, 'work'), 'chat'));
      },
      transcriptFor: sessionId => transcript(snapshots[sessionId]),
      sendFollowUp: async (item, text) => {
        const connection = connectionRef.current;
        const projectId = projectRef.current;
        if (!connection || !projectId) throw new Error('Connect to a desktop project before sending a message.');
        const messageId = commandId('message');
        setFollowUps(list => addFollowUp(list, {
          messageId,
          hostId: host.hostId,
          projectId,
          sessionId: item.sessionId,
          workId: item.workId,
          text,
          state: 'pending',
          createdAt: new Date().toISOString(),
        }) as MobileFollowUp[]);
        try {
          const base: Omit<MobileCommand, 'operation' | 'target' | 'payload'> = {
            protocolVersion: 1,
            commandId: messageId,
            issuedAt: new Date().toISOString(),
            caller,
          };
          const snapshot = item.draft
            ? await connection.command<MobileSessionSnapshot>({
                ...base,
                operation: 'sessions.create',
                target: target(),
                payload: { title: text.slice(0, 80), message: text },
              })
            : await connection.command<MobileSessionSnapshot>({
                ...base,
                operation: 'sessions.continue',
                target: target({ sessionId: item.sessionId }),
                payload: { message: text },
              });
          applySnapshot(snapshot);
          setOpenWorkId(snapshot.sessionKey);
          setWork(previous => previous.filter(entry => !entry.draft || entry.workId !== item.workId));
          setFollowUps(list => list.filter(message => message.messageId !== messageId));
        } catch (error) {
          setFollowUps(list => updateFollowUp(list, messageId, 'failed', error instanceof Error ? error.message : String(error)) as MobileFollowUp[]);
          throw error;
        }
      },
      cancelSession: async sessionId => {
        const connection = connectionRef.current;
        if (!connection) return;
        const snapshot = await connection.command<MobileSessionSnapshot>({
          protocolVersion: 1,
          commandId: commandId('cancel'),
          issuedAt: new Date().toISOString(),
          caller,
          target: target({ sessionId }),
          operation: 'sessions.cancel',
          payload: {},
        });
        applySnapshot(snapshot);
      },
      respondToPermission: async (requestId, decision) => {
        const connection = connectionRef.current;
        if (!connection) return;
        await connection.command({
          protocolVersion: 1,
          commandId: commandId('permission'),
          issuedAt: new Date().toISOString(),
          caller,
          target: target({ requestId }),
          operation: 'permissions.respond',
          payload: { decision },
        });
        setAttention(list => list.map(entry => (entry.requestId === requestId ? { ...entry, resolved: true } : entry)));
      },
      startWorkflow: async (workflowId, task) => {
        const connection = connectionRef.current;
        if (!connection) return;
        await connection.command({
          protocolVersion: 1,
          commandId: commandId('workflow'),
          issuedAt: new Date().toISOString(),
          caller,
          target: target(),
          operation: 'workflowRuns.start',
          payload: { workflowId, task },
        });
      },
      approve: async runId => {
        const connection = connectionRef.current;
        if (!connection) return;
        await connection.command({
          protocolVersion: 1,
          commandId: commandId('approve'),
          issuedAt: new Date().toISOString(),
          caller,
          target: target({ runId }),
          operation: 'workflowGates.approve',
          payload: {},
        });
        setAttention(list => list.map(entry => (entry.runId === runId ? { ...entry, resolved: true } : entry)));
      },
      loadRun: async runId => {
        const connection = connectionRef.current;
        if (!connection) return;
        const summary = await connection.read<MobileRunSummary>({
          protocolVersion: 1,
          requestId: commandId('run'),
          caller,
          target: target({ runId }),
          operation: 'workflowRuns.get',
        });
        setRuns(previous => ({ ...previous, [runId]: summary }));
      },
    };
  }, [shell, host, project, work, attention, followUps, workflows, runs, openWorkId, connectionError, snapshots]);

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
