import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type {
  MobileCaller,
  MobileCommand,
  MobileDeviceAccess,
  MobileEventEnvelope,
  MobileHostInfo,
  MobileModelCatalog,
  MobileProviderCatalog,
  MobileReadOperation,
  MobileReadRequest,
  MobileSessionEvent,
  MobileSessionMode,
  MobileSessionSnapshot,
  MobileSessionSummary,
  MobileSessionUsage,
} from '@praxis/core';
import { MobileEventCursor, mergeSequencedSnapshot } from '@praxis/mobile-protocol';
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
import { describeUsage, latestUsage, type MobileUsageView } from '../renderer/mobileUsage';
import {
  DEFAULT_SESSION_SELECTION,
  effectiveSelection,
  providerOption,
  selectionPayload,
  validateSelection,
  type MobileSessionSelection,
} from '../renderer/mobileSessionOptions';
import { describeConnectionIssue, reconnectDelayMs, type MobileConnectionIssue } from '../renderer/mobilePairingInvitation';
import {
  NativeMobileConnection,
  forgetMobileHostConfiguration,
  mobileDeviceKeyPrefix,
  saveMobileHostConfiguration,
  type MobileHostConfiguration,
} from './mobileConnection';

export { MOBILE_PRIMARY_ROUTES };
export type { MobilePrimaryRoute, MobileDetailTab };

export interface MobileHostSummary { hostId: string; hostName: string; online: boolean }
export interface MobileProjectSummary { projectId: string; name: string; workflow?: string }
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
export interface MobileWorkItem {
  workId: string;
  title: string;
  status: string;
  sessionId: string;
  runId?: string;
  provider?: string;
  model?: string;
  mode: MobileSessionMode;
  /** Not yet created on the desktop; `selection` is what the first message will launch. */
  draft?: boolean;
  selection?: MobileSessionSelection;
}
export interface MobileTranscriptMessage {
  id: string;
  /** `system`: runtime notices (handover, model change) and errors. */
  author: 'user' | 'assistant' | 'system';
  text: string;
  at: string;
  streaming: boolean;
}
export interface MobileActivityEntry { id: string; at: string; workId: string; title: string; text: string }

/** A host-backed value that may still be loading, or not offered by an older desktop. */
export interface Remote<T> { status: 'idle' | 'loading' | 'ready' | 'unsupported' | 'error'; value?: T; message?: string }

interface Store {
  shell: MobileShellState;
  host: MobileHostSummary;
  hostInfo: MobileHostInfo | undefined;
  hostConfig: MobileHostConfiguration | undefined;
  project: MobileProjectSummary;
  work: MobileWorkItem[];
  attention: MobileAttentionItem[];
  followUps: MobileFollowUp[];
  workflows: MobileWorkflowChoice[];
  runs: Record<string, MobileRunSummary>;
  openWorkId: string | undefined;
  connectionIssue: MobileConnectionIssue | undefined;
  pairing: { message: string; deviceLabel?: string } | undefined;
  providers: Remote<MobileProviderCatalog>;
  models: Record<string, Remote<MobileModelCatalog>>;
  access: Remote<MobileDeviceAccess>;
  activity: MobileActivityEntry[];

  connect(config: MobileHostConfiguration): Promise<void>;
  retryConnection(): void;
  cancelConnect(): void;
  disconnect(options?: { forget?: boolean }): void;
  setRoute(primary: MobilePrimaryRoute): void;
  setDetail(detail: MobileDetailTab): void;
  openWork(workId: string | undefined): void;
  startNewChat(): void;
  transcriptFor(sessionId: string): MobileTranscriptMessage[];
  usageFor(item: MobileWorkItem): MobileUsageView;
  refreshUsage(sessionId: string): Promise<void>;
  refreshProviders(): Promise<void>;
  loadModels(provider: string, refresh?: boolean): Promise<void>;
  updateDraftSelection(workId: string, patch: Partial<MobileSessionSelection>): void;
  /** Between-turn provider handover / model change / mode switch of an existing session. */
  configureSession(item: MobileWorkItem, change: { provider?: string; model?: string; mode?: MobileSessionMode }): Promise<void>;
  sendFollowUp(work: MobileWorkItem, text: string): Promise<void>;
  retryFollowUp(messageId: string): Promise<void>;
  cancelSession(sessionId: string): Promise<void>;
  respondToPermission(requestId: string, decision: 'allow' | 'deny'): Promise<void>;
  startWorkflow(workflowId: string, task: string): Promise<void>;
  approve(runId: string): Promise<void>;
  loadRun(runId: string): Promise<void>;
}

const StoreContext = createContext<Store | undefined>(undefined);
/** The desktop replaces this with the Noise-authenticated device identity. */
const caller: MobileCaller = { deviceId: 'praxis-mobile', capabilities: ['view', 'execute', 'approve'] };
const NO_HOST: MobileHostSummary = { hostId: '', hostName: '', online: false };
const NO_PROJECT: MobileProjectSummary = { projectId: '', name: '' };

function commandId(prefix: string): string {
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function workFromSession(session: MobileSessionSummary): MobileWorkItem {
  return {
    workId: session.sessionKey,
    title: session.title,
    status: session.lifecycle,
    sessionId: session.sessionId,
    mode: session.mode,
    ...(session.provider ? { provider: session.provider } : {}),
    ...(session.model ? { model: session.model } : {}),
    ...(session.runId ? { runId: session.runId } : {}),
  };
}

const clock = (at: string): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function transcript(snapshot: MobileSessionSnapshot | undefined): MobileTranscriptMessage[] {
  if (!snapshot) return [];
  return snapshot.messages
    .map(message => ({
      id: message.id,
      author: message.role,
      text: message.text,
      at: clock(message.at),
      streaming: message.status === 'streaming',
    }));
}

const LIFECYCLE_TEXT: Record<string, string> = {
  active: 'Working',
  'awaiting-input': 'Waiting for you',
  completed: 'Finished',
  failed: 'Failed',
  stopped: 'Stopped',
  idle: 'Idle',
};

function permissionItems(hostId: string, snapshot: MobileSessionSnapshot): MobileAttentionItem[] {
  if (!snapshot.projectId) return [];
  return snapshot.pendingPermissions.map(permission => ({
    id: `permission:${permission.requestId}`,
    kind: 'permission' as const,
    hostId,
    projectId: snapshot.projectId!,
    sessionId: snapshot.sessionId,
    requestId: permission.requestId,
    summary: permission.summary,
    ...(permission.detail ? { detail: permission.detail } : {}),
    createdAt: permission.createdAt,
    resolved: false,
  }));
}

export function StoreProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [shell, setShell] = useState<MobileShellState>(() => createMobileShellState());
  const [host, setHost] = useState<MobileHostSummary>(NO_HOST);
  const [hostInfo, setHostInfo] = useState<MobileHostInfo | undefined>(undefined);
  const [hostConfig, setHostConfig] = useState<MobileHostConfiguration | undefined>(undefined);
  const [project, setProject] = useState<MobileProjectSummary>(NO_PROJECT);
  const [work, setWork] = useState<MobileWorkItem[]>([]);
  const [snapshots, setSnapshots] = useState<Readonly<Record<string, MobileSessionSnapshot>>>({});
  const [usageReads, setUsageReads] = useState<Record<string, MobileSessionUsage>>({});
  const [attention, setAttention] = useState<MobileAttentionItem[]>([]);
  const [followUps, setFollowUps] = useState<MobileFollowUp[]>([]);
  const [workflows, setWorkflows] = useState<MobileWorkflowChoice[]>([]);
  const [runs, setRuns] = useState<Record<string, MobileRunSummary>>({});
  const [openWorkId, setOpenWorkId] = useState<string | undefined>(undefined);
  const [connectionIssue, setConnectionIssue] = useState<MobileConnectionIssue | undefined>(undefined);
  const [pairing, setPairing] = useState<{ message: string; deviceLabel?: string } | undefined>(undefined);
  const [providers, setProviders] = useState<Remote<MobileProviderCatalog>>({ status: 'idle' });
  const [models, setModels] = useState<Record<string, Remote<MobileModelCatalog>>>({});
  const [access, setAccess] = useState<Remote<MobileDeviceAccess>>({ status: 'idle' });

  const connectionRef = useRef<NativeMobileConnection | undefined>(undefined);
  const unsubscribeRef = useRef<Array<() => void>>([]);
  const configRef = useRef<MobileHostConfiguration | undefined>(undefined);
  const projectRef = useRef<string | undefined>(undefined);
  const hostInfoRef = useRef<MobileHostInfo | undefined>(undefined);
  const cursorRef = useRef(new MobileEventCursor());
  const phaseRef = useRef<MobileShellState['connection']>('offline');
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commandsRef = useRef(new Map<string, { command: MobileCommand; workId: string; draft: boolean }>());
  const openConnectionRef = useRef<(config: MobileHostConfiguration, mode: 'initial' | 'reconnect') => Promise<void>>(async () => undefined);

  const setPhase = useCallback((phase: MobileShellState['connection']): void => {
    phaseRef.current = phase;
    setShell(previous => setMobileShellConnection(previous, phase));
  }, []);

  const supports = (operation: MobileReadOperation): boolean =>
    hostInfoRef.current ? hostInfoRef.current.readOperations.includes(operation) : false;

  const readRequest = (operation: MobileReadOperation, target: MobileReadRequest['target'], params?: MobileReadRequest['params']): MobileReadRequest => ({
    protocolVersion: 1,
    requestId: commandId(operation),
    caller,
    target,
    operation,
    ...(params ? { params } : {}),
  });

  const applySnapshot = useCallback((snapshot: MobileSessionSnapshot): void => {
    setSnapshots(previous => mergeSequencedSnapshot(previous, snapshot));
    setWork(previous => {
      const index = previous.findIndex(item => item.sessionId === snapshot.sessionId || item.workId === snapshot.sessionKey);
      if (snapshot.archived) return index < 0 ? previous : previous.filter((_, position) => position !== index);
      const next = workFromSession(snapshot);
      if (index < 0) return [next, ...previous];
      const copy = [...previous];
      copy[index] = next;
      return copy;
    });
    const hostId = configRef.current?.hostId ?? '';
    setAttention(previous => [
      ...previous.filter(item => item.kind !== 'permission' || item.sessionId !== snapshot.sessionId),
      ...permissionItems(hostId, snapshot),
    ]);
  }, []);

  const applyEvent = useCallback((envelope: MobileEventEnvelope): void => {
    if (!cursorRef.current.observe(envelope.sequence)) return;
    const event = envelope.event as MobileSessionEvent;
    if (event.type === 'session.snapshot') applySnapshot(event.snapshot);
    if (event.type === 'session.removed') {
      setWork(previous => previous.filter(item => item.sessionId !== event.sessionId));
      setSnapshots(previous => {
        const next = { ...previous };
        delete next[event.sessionId];
        return next;
      });
    }
  }, [applySnapshot]);

  const clearReconnectTimer = (): void => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = undefined;
  };

  const scheduleReconnect = useCallback((): void => {
    clearReconnectTimer();
    const delay = reconnectDelayMs(reconnectAttemptRef.current);
    reconnectAttemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      const config = configRef.current;
      if (config && phaseRef.current === 'reconnecting') void openConnectionRef.current(config, 'reconnect');
    }, delay);
  }, []);

  const closeConnection = (): void => {
    for (const unsubscribe of unsubscribeRef.current) unsubscribe();
    unsubscribeRef.current = [];
    connectionRef.current?.close();
    connectionRef.current = undefined;
  };

  /** Everything the phone shows is re-read from the desktop; replay then resumes after the pinned cursor. */
  const bootstrap = useCallback(async (connection: NativeMobileConnection, config: MobileHostConfiguration): Promise<MobileHostConfiguration> => {
    const hostTarget = { hostId: config.hostId };
    let info: MobileHostInfo | undefined;
    try {
      info = await connection.read<MobileHostInfo>(readRequest('host.info', hostTarget));
    } catch {
      info = undefined; // A desktop from before revision 2: no catalog, usage or access reads.
    }
    const epochChanged = hostInfoRef.current?.hostEpoch !== info?.hostEpoch;
    hostInfoRef.current = info;
    setHostInfo(info);
    if (epochChanged) {
      // The desktop restarted: its event sequence restarted too.
      cursorRef.current.reset(info?.latestSequence ?? 0);
      setSnapshots({});
      setUsageReads({});
    }
    setHost({ hostId: config.hostId, hostName: info?.hostName ?? config.hostName?.trim() ?? config.address, online: true });

    let projectSummary: MobileProjectSummary;
    if (config.projectId) {
      projectSummary = await connection.read<MobileProjectSummary>(readRequest('projects.snapshot', { ...hostTarget, projectId: config.projectId }));
    } else {
      const available = await connection.read<{ projects: MobileProjectSummary[] }>(readRequest('projects.snapshot', hostTarget));
      const first = available.projects[0];
      if (!first) throw new Error('This phone has not been granted access to a project. Change its grant in Settings → Mobile access on the desktop.');
      projectSummary = first;
    }
    const projectId = projectSummary.projectId;
    const target = { ...hostTarget, projectId };
    projectRef.current = projectId;
    setProject(projectSummary);
    const saved: MobileHostConfiguration = { ...config, projectId };
    await saveMobileHostConfiguration(saved);

    const sessions = (await connection.read<readonly MobileSessionSummary[]>(readRequest('sessions.list', target))).filter(session => !session.archived);
    const loaded = await Promise.all(sessions.map(session =>
      connection.read<MobileSessionSnapshot>(readRequest('sessions.get', { ...target, sessionId: session.sessionId }))));
    setSnapshots(previous => {
      // Sessions the desktop no longer lists drop out; a live event newer than the read is kept.
      const next: Record<string, MobileSessionSnapshot> = {};
      for (const snapshot of loaded) {
        const existing = previous[snapshot.sessionId];
        next[snapshot.sessionId] = existing && existing.sequence > snapshot.sequence ? existing : snapshot;
      }
      return next;
    });
    setWork(previous => [...previous.filter(item => item.draft), ...sessions.map(workFromSession)]);
    setOpenWorkId(current => current && (sessions.some(session => session.sessionKey === current) || current.startsWith('draft-')) ? current : sessions[0]?.sessionKey);

    const choices = await connection.read<MobileWorkflowChoice[]>(readRequest('workflows.list', target));
    setWorkflows(choices.filter(choice => choice.trigger !== 'ticket'));
    setAttention(await connection.read<MobileAttentionItem[]>(readRequest('attention.list', target)));

    if (info?.readOperations.includes('providers.list')) {
      setProviders(previous => ({ ...previous, status: 'loading' }));
      try {
        setProviders({ status: 'ready', value: await connection.read<MobileProviderCatalog>(readRequest('providers.list', target)) });
      } catch (error) {
        setProviders({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    } else {
      setProviders({ status: 'unsupported', message: 'This desktop does not share its AI providers with the phone. Update Praxis on the desktop to choose a provider and model here.' });
    }
    if (info?.readOperations.includes('access.get')) {
      try {
        setAccess({ status: 'ready', value: await connection.read<MobileDeviceAccess>(readRequest('access.get', hostTarget)) });
      } catch (error) {
        setAccess({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      }
    } else {
      setAccess({ status: 'unsupported', message: 'This desktop does not report the phone’s access grant. Update Praxis on the desktop.' });
    }

    // The reads are current as of `latestSequence`: replay what came after.
    // Events that already arrived live are skipped by the cursor, and
    // merge-by-sequence makes any re-delivery a no-op.
    const latest = info?.latestSequence ?? 0;
    if (cursorRef.current.sequence < latest) cursorRef.current.reset(latest);
    await connection.replay(latest);
    return saved;
  }, []);

  const handleConnectionLoss = useCallback((error: unknown): void => {
    const issue = describeConnectionIssue(error);
    setConnectionIssue(issue);
    setHost(previous => ({ ...previous, online: false }));
    if (issue.retryable && (phaseRef.current === 'ready' || phaseRef.current === 'reconnecting')) {
      setPhase('reconnecting');
      scheduleReconnect();
      return;
    }
    clearReconnectTimer();
    setPairing(undefined);
    setPhase('offline');
  }, [scheduleReconnect, setPhase]);

  const openConnection = useCallback(async (config: MobileHostConfiguration, mode: 'initial' | 'reconnect'): Promise<void> => {
    clearReconnectTimer();
    closeConnection();
    const connection = new NativeMobileConnection(config);
    connectionRef.current = connection;
    configRef.current = config;
    setHostConfig(config);
    const current = (): boolean => connectionRef.current === connection;
    if (mode === 'initial') {
      setConnectionIssue(undefined);
      setPhase('connecting');
    }
    unsubscribeRef.current = [
      connection.subscribe(envelope => { if (current()) applyEvent(envelope); }),
      connection.subscribeStatus(status => {
        if (!current()) return;
        if (status.code === 'pairing-pending') {
          setPhase('pairing');
          void mobileDeviceKeyPrefix().then(prefix => setPairing({ message: status.message, deviceLabel: `Phone ${prefix}` }));
        } else if (status.code === 'pairing-required' && config.pairingTokenId) {
          setPairing({ message: 'Presenting the pairing invitation to the desktop…' });
        }
      }),
      connection.subscribeClose(error => { if (current()) handleConnectionLoss(error); }),
    ];
    try {
      await connection.connect();
      if (!current()) return;
      let effective = config;
      if (config.pairingTokenId) {
        // Confirmed: the invitation is spent, so do not keep or re-present it.
        const { pairingTokenId: _token, pairingExpiresAt: _expires, ...rest } = config;
        effective = rest;
        configRef.current = effective;
      }
      const saved = await bootstrap(connection, effective);
      if (!current()) return;
      configRef.current = saved;
      setHostConfig(saved);
      reconnectAttemptRef.current = 0;
      setConnectionIssue(undefined);
      setPairing(undefined);
      setPhase('ready');
    } catch (error) {
      if (!current()) return;
      closeConnection();
      if (mode === 'reconnect') {
        handleConnectionLoss(error);
        return;
      }
      setPairing(undefined);
      setConnectionIssue(describeConnectionIssue(error));
      setPhase('offline');
    }
  }, [applyEvent, bootstrap, handleConnectionLoss, setPhase]);
  openConnectionRef.current = openConnection;

  // Attention needs a poll: workflow approvals and failures are not session events.
  useEffect(() => {
    if (shell.connection !== 'ready') return;
    const refresh = (): void => {
      const connection = connectionRef.current;
      const projectId = projectRef.current;
      const hostId = configRef.current?.hostId;
      if (!connection || !projectId || !hostId) return;
      void connection.read<MobileAttentionItem[]>(readRequest('attention.list', { hostId, projectId })).then(setAttention).catch(() => undefined);
    };
    const timer = setInterval(refresh, 5_000);
    return () => clearInterval(timer);
  }, [shell.connection]);

  // Returning to the foreground: a suspended socket is often dead without a close event.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      const config = configRef.current;
      if (!config) return;
      if (phaseRef.current === 'reconnecting') {
        reconnectAttemptRef.current = 0;
        void openConnectionRef.current(config, 'reconnect');
        return;
      }
      const connection = connectionRef.current;
      if (phaseRef.current !== 'ready' || !connection) return;
      void connection.read<MobileHostInfo>(readRequest('host.info', { hostId: config.hostId }))
        .then(info => {
          if (info.hostEpoch !== hostInfoRef.current?.hostEpoch) return openConnectionRef.current(config, 'reconnect');
          return connection.replay(cursorRef.current.sequence).then(() => undefined);
        })
        .catch(() => {
          setPhase('reconnecting');
          reconnectAttemptRef.current = 0;
          void openConnectionRef.current(config, 'reconnect');
        });
    });
    return () => subscription.remove();
  }, [setPhase]);

  useEffect(() => () => {
    clearReconnectTimer();
    closeConnection();
  }, []);

  const value = useMemo<Store>(() => {
    const nav = (mutate: (state: MobileNavigationState) => MobileNavigationState): void =>
      setShell(previous => ({ ...previous, navigation: mutate(previous.navigation) }));

    const target = (extra: Record<string, string | undefined> = {}) => ({
      hostId: configRef.current?.hostId ?? host.hostId,
      ...(projectRef.current ? { projectId: projectRef.current } : {}),
      ...extra,
    });

    const requireConnection = (): NativeMobileConnection => {
      const connection = connectionRef.current;
      if (!connection || phaseRef.current !== 'ready') {
        throw new Error(phaseRef.current === 'reconnecting'
          ? 'The desktop connection dropped. Praxis is reconnecting — try again in a moment.'
          : 'Connect to a desktop project first.');
      }
      return connection;
    };

    const sendCommand = async (messageId: string): Promise<void> => {
      const entry = commandsRef.current.get(messageId);
      if (!entry) return;
      try {
        const snapshot = await requireConnection().command<MobileSessionSnapshot>(entry.command);
        commandsRef.current.delete(messageId);
        applySnapshot(snapshot);
        setOpenWorkId(snapshot.sessionKey);
        if (entry.draft) setWork(previous => previous.filter(item => !item.draft || item.workId !== entry.workId));
        setFollowUps(list => list.filter(message => message.messageId !== messageId));
      } catch (error) {
        setFollowUps(list => updateFollowUp(list, messageId, 'failed', error instanceof Error ? error.message : String(error)) as MobileFollowUp[]);
      }
    };

    const catalog = providers.value;
    const activity: MobileActivityEntry[] = work
      .filter(item => !item.draft)
      .map(item => {
        const snapshot = snapshots[item.sessionId];
        const last = snapshot?.messages[snapshot.messages.length - 1];
        const at = last?.at ?? snapshot?.completedAt ?? snapshot?.startedAt;
        return {
          id: item.sessionId,
          at: at ?? '',
          workId: item.workId,
          title: item.title,
          text: `${LIFECYCLE_TEXT[item.status] ?? item.status}${last ? ` — ${last.role === 'user' ? 'You' : last.role === 'system' ? 'Desktop' : 'Agent'}: ${last.text.slice(0, 120)}` : ''}`,
        };
      })
      .filter(entry => entry.at)
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, 40)
      .map(entry => ({ ...entry, at: clock(entry.at) }));

    return {
      shell,
      host,
      hostInfo,
      hostConfig,
      project,
      work,
      attention,
      followUps,
      workflows,
      runs,
      openWorkId,
      connectionIssue,
      pairing,
      providers,
      models,
      access,
      activity,

      connect: config => openConnection(config, 'initial'),
      retryConnection: () => {
        const config = configRef.current;
        if (!config) return;
        reconnectAttemptRef.current = 0;
        void openConnection(config, phaseRef.current === 'reconnecting' ? 'reconnect' : 'initial');
      },
      cancelConnect: () => {
        clearReconnectTimer();
        closeConnection();
        setPairing(undefined);
        setPhase('offline');
      },
      disconnect: options => {
        clearReconnectTimer();
        closeConnection();
        projectRef.current = undefined;
        hostInfoRef.current = undefined;
        cursorRef.current.reset(0);
        commandsRef.current.clear();
        setShell(createMobileShellState());
        phaseRef.current = 'offline';
        setHost(NO_HOST);
        setHostInfo(undefined);
        setProject(NO_PROJECT);
        setWork([]);
        setSnapshots({});
        setUsageReads({});
        setAttention([]);
        setFollowUps([]);
        setWorkflows([]);
        setRuns({});
        setProviders({ status: 'idle' });
        setModels({});
        setAccess({ status: 'idle' });
        setOpenWorkId(undefined);
        setConnectionIssue(undefined);
        setPairing(undefined);
        if (options?.forget) {
          configRef.current = undefined;
          setHostConfig(undefined);
          void forgetMobileHostConfiguration();
        }
      },
      setRoute: primary => nav(state => selectMobileRoute(state, primary)),
      setDetail: detail => nav(state => selectMobileDetail(state, detail)),
      openWork: workId => setOpenWorkId(workId),
      startNewChat: () => {
        const id = `draft-${Date.now().toString(36)}`;
        const item: MobileWorkItem = { workId: id, title: 'New chat', status: 'idle', sessionId: id, mode: 'chat', draft: true, selection: DEFAULT_SESSION_SELECTION };
        setWork(list => [item, ...list]);
        setOpenWorkId(item.workId);
        nav(state => selectMobileDetail(selectMobileRoute(state, 'work'), 'chat'));
      },
      transcriptFor: sessionId => transcript(snapshots[sessionId]),
      usageFor: item => {
        if (item.draft) {
          const selection = effectiveSelection(catalog, item.selection ?? DEFAULT_SESSION_SELECTION);
          return describeUsage({ source: undefined, loading: false, draft: true, ...(selection.providerOption ? { providerLabel: selection.providerOption.label } : {}) });
        }
        const snapshot = snapshots[item.sessionId];
        const label = providerOption(catalog, item.provider)?.label;
        return describeUsage({ source: latestUsage(snapshot, usageReads[item.sessionId]), loading: !snapshot, ...(label ? { providerLabel: label } : {}) });
      },
      refreshUsage: async sessionId => {
        const connection = connectionRef.current;
        if (!connection || phaseRef.current !== 'ready' || !supports('sessions.usage')) return;
        const usage = await connection.read<MobileSessionUsage>(readRequest('sessions.usage', target({ sessionId })));
        setUsageReads(previous => ({ ...previous, [sessionId]: usage }));
      },
      refreshProviders: async () => {
        const connection = connectionRef.current;
        if (!connection || phaseRef.current !== 'ready' || !supports('providers.list')) return;
        setProviders(previous => ({ ...previous, status: 'loading' }));
        try {
          setProviders({ status: 'ready', value: await connection.read<MobileProviderCatalog>(readRequest('providers.list', target())) });
        } catch (error) {
          setProviders(previous => ({ ...previous, status: 'error', message: error instanceof Error ? error.message : String(error) }));
        }
      },
      loadModels: async (provider, refresh = false) => {
        const connection = connectionRef.current;
        if (!connection || phaseRef.current !== 'ready' || !supports('models.list')) return;
        setModels(previous => ({ ...previous, [provider]: { ...previous[provider], status: 'loading' } }));
        try {
          const catalogForProvider = await connection.read<MobileModelCatalog>(readRequest('models.list', target(), { provider, ...(refresh ? { refresh: true } : {}) }));
          setModels(previous => ({ ...previous, [provider]: { status: 'ready', value: catalogForProvider } }));
        } catch (error) {
          setModels(previous => ({ ...previous, [provider]: { status: 'error', message: error instanceof Error ? error.message : String(error) } }));
        }
      },
      updateDraftSelection: (workId, patch) => {
        setWork(previous => previous.map(item => item.workId === workId && item.draft
          ? { ...item, selection: { ...(item.selection ?? DEFAULT_SESSION_SELECTION), ...patch } }
          : item));
      },
      configureSession: async (item, change) => {
        const snapshot = await requireConnection().command<MobileSessionSnapshot>({
          protocolVersion: 1,
          commandId: commandId('configure'),
          issuedAt: new Date().toISOString(),
          caller,
          target: target({ sessionId: item.sessionId }),
          operation: 'sessions.configure',
          payload: change,
        });
        applySnapshot(snapshot);
      },
      sendFollowUp: async (item, text) => {
        const projectId = projectRef.current;
        if (!projectId) throw new Error('Connect to a desktop project before sending a message.');
        const messageId = commandId('message');
        const base = { protocolVersion: 1 as const, commandId: messageId, issuedAt: new Date().toISOString(), caller };
        let command: MobileCommand;
        if (item.draft) {
          const selection = effectiveSelection(catalog, item.selection ?? DEFAULT_SESSION_SELECTION, models[item.selection?.provider ?? '']?.value);
          const verdict = validateSelection(catalog, selection, selection.provider ? models[selection.provider]?.value : undefined);
          if (!verdict.ok) throw new Error(verdict.message);
          command = { ...base, operation: 'sessions.create', target: target(), payload: { title: text.slice(0, 80), message: text, ...selectionPayload(selection) } };
        } else {
          command = { ...base, operation: 'sessions.continue', target: target({ sessionId: item.sessionId }), payload: { message: text } };
        }
        commandsRef.current.set(messageId, { command, workId: item.workId, draft: Boolean(item.draft) });
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
        await sendCommand(messageId);
      },
      retryFollowUp: async messageId => {
        // Same command id: if the desktop already ran it, it answers with the recorded outcome.
        setFollowUps(list => updateFollowUp(list, messageId, 'pending') as MobileFollowUp[]);
        await sendCommand(messageId);
      },
      cancelSession: async sessionId => {
        const snapshot = await requireConnection().command<MobileSessionSnapshot>({
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
        await requireConnection().command({
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
        await requireConnection().command({
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
        await requireConnection().command({
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
        if (!connection || phaseRef.current !== 'ready') return;
        const summary = await connection.read<MobileRunSummary>(readRequest('workflowRuns.get', target({ runId })));
        setRuns(previous => ({ ...previous, [runId]: summary }));
      },
    };
  }, [shell, host, hostInfo, hostConfig, project, work, attention, followUps, workflows, runs, openWorkId, connectionIssue, pairing, providers, models, access, snapshots, usageReads, applySnapshot, openConnection, setPhase]);

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
