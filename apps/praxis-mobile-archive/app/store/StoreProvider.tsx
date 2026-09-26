import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type {
  MobileCommand,
  MobileDeviceAccess,
  MobileEventEnvelope,
  MobileHostEvent,
  MobileHostInfo,
  MobileModelCatalog,
  MobileProviderCatalog,
  MobileRunEvent,
  MobileRunSnapshot,
  MobileSessionEvent,
  MobileSessionSnapshot,
  MobileSessionSummary,
  MobileSessionUsage,
} from '@praxis/core';
import { MobileEventCursor, mergeSequencedSnapshot } from '@praxis/mobile-protocol';
import { applyAppearance, currentAppearance } from '../theme';
import { readMobileAppearance } from '../../renderer/mobileTheme';
import { createMobileShellState, setMobileShellConnection, type MobileShellState } from '../../renderer/mobileShellState';
import { selectMobileDetail, selectMobileRoute, type MobileNavigationState } from '../../renderer/mobileNavigation';
import type { MobileFollowUp } from '../../renderer/mobileFollowUp';
import { combineAttention, openMobileAttention, runAttentionItems, type MobileAttentionItem } from '../../renderer/mobileAttention';
import { describeUsage, latestUsage } from '../../renderer/mobileUsage';
import { DEFAULT_SESSION_SELECTION, effectiveSelection, providerOption } from '../../renderer/mobileSessionOptions';
import { describeConnectionIssue, reconnectDelayMs, type MobileConnectionIssue } from '../../renderer/mobilePairingInvitation';
import {
  NativeMobileConnection,
  forgetMobileHostConfiguration,
  loadDesktopAppearance,
  saveDesktopAppearance,
  mobileDeviceKeyPrefix,
  saveMobileHostConfiguration,
  type MobileHostConfiguration,
} from '../mobileConnection';
import { isStageSessionKey, mergeRun, removeRun, replaceRuns } from '../../renderer/mobileWorkflowRuns';
import { forgetIdentityCheck } from '../confirmIdentity';
import { recordDiagnostic, refreshFailed, refreshSucceeded } from '../diagnostics';
import { createStoreActions } from './actions';
import { activityEntries, permissionItems, readRequest, transcript, workFromSession } from './projections';
import type { MobileHostSummary, MobileProjectSummary, MobileRunSummary, MobileWorkflowChoice, MobileWorkItem, Remote, Store } from './types';

const StoreContext = createContext<Store | undefined>(undefined);
const NO_HOST: MobileHostSummary = { hostId: '', hostName: '', online: false };
const NO_PROJECT: MobileProjectSummary = { projectId: '', name: '' };

/**
 * How often the phone re-reads the desktop's attention list. Approvals,
 * failures and permissions reach the phone live as run and session events;
 * this poll is only a safety net — unless the desktop is too old to send run
 * events, when it is the only source and runs as often as before.
 */
const ATTENTION_SAFETY_POLL_MS = 60_000;
const ATTENTION_LEGACY_POLL_MS = 5_000;

/** Paints the desktop's theme and remembers it for the next launch; anything malformed is ignored. */
function wearDesktopAppearance(value: unknown): void {
  const appearance = readMobileAppearance(value);
  if (appearance && applyAppearance(appearance)) void saveDesktopAppearance(appearance).catch(error => recordDiagnostic('Saving the desktop theme', error));
}

export function StoreProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [shell, setShell] = useState<MobileShellState>(() => createMobileShellState());
  const [autoConnectEnabled, setAutoConnectEnabled] = useState(true);
  const [host, setHost] = useState<MobileHostSummary>(NO_HOST);
  const [hostInfo, setHostInfo] = useState<MobileHostInfo | undefined>(undefined);
  const [hostConfig, setHostConfig] = useState<MobileHostConfiguration | undefined>(undefined);
  const [project, setProject] = useState<MobileProjectSummary>(NO_PROJECT);
  const [work, setWork] = useState<MobileWorkItem[]>([]);
  const [snapshots, setSnapshots] = useState<Readonly<Record<string, MobileSessionSnapshot>>>({});
  const [usageReads, setUsageReads] = useState<Record<string, MobileSessionUsage>>({});
  const [polledAttention, setPolledAttention] = useState<MobileAttentionItem[]>([]);
  const [resolvedIds, setResolvedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [followUps, setFollowUps] = useState<MobileFollowUp[]>([]);
  const [workflows, setWorkflows] = useState<MobileWorkflowChoice[]>([]);
  const [runs, setRuns] = useState<Record<string, MobileRunSummary>>({});
  const [workflowRuns, setWorkflowRuns] = useState<MobileRunSnapshot[]>([]);
  const [runsSupported, setRunsSupported] = useState(false);
  const [openWorkId, setOpenWorkId] = useState<string | undefined>(undefined);
  const [openRunId, setOpenRunId] = useState<string | undefined>(undefined);
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

  // Wear the paired desktop's last theme straight away; host.info replaces it once connected.
  useEffect(() => {
    void loadDesktopAppearance().then(stored => {
      if (stored && !currentAppearance()) applyAppearance(stored);
    }).catch(error => recordDiagnostic('Loading the saved desktop theme', error));
  }, []);

  const setPhase = useCallback((phase: MobileShellState['connection']): void => {
    phaseRef.current = phase;
    setShell(previous => setMobileShellConnection(previous, phase));
  }, []);

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
  }, []);

  const applyEvent = useCallback((envelope: MobileEventEnvelope): void => {
    if (!cursorRef.current.observe(envelope.sequence)) return;
    const event = envelope.event as MobileSessionEvent | MobileHostEvent | MobileRunEvent;
    if (event.type === 'host.appearance') {
      wearDesktopAppearance(event.appearance);
      return;
    }
    if (event.type === 'run.snapshot') {
      setWorkflowRuns(previous => mergeRun(previous, event.run));
      return;
    }
    if (event.type === 'run.removed') {
      setWorkflowRuns(previous => removeRun(previous, event.runId));
      setOpenRunId(current => (current === event.runId ? undefined : current));
      return;
    }
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
    wearDesktopAppearance(info?.appearance);
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
    // Land on a chat, not on one of a workflow run's stage sessions (those open through their run).
    const firstChat = sessions.find(session => !isStageSessionKey(session.sessionKey, session.runId));
    setOpenWorkId(current => current && (sessions.some(session => session.sessionKey === current) || current.startsWith('draft-')) ? current : firstChat?.sessionKey);

    const choices = await connection.read<MobileWorkflowChoice[]>(readRequest('workflows.list', target));
    setWorkflows(choices.filter(choice => choice.trigger !== 'ticket'));
    const listsRuns = Boolean(info?.readOperations.includes('workflowRuns.list'));
    setRunsSupported(listsRuns);
    if (listsRuns) {
      const listed = await connection.read<MobileRunSnapshot[]>(readRequest('workflowRuns.list', target));
      setWorkflowRuns(previous => replaceRuns(previous, listed));
      setOpenRunId(current => (current && listed.some(run => run.runId === current) ? current : undefined));
    } else {
      setWorkflowRuns([]);
      setOpenRunId(undefined);
    }
    setPolledAttention(await connection.read<MobileAttentionItem[]>(readRequest('attention.list', target)));
    refreshSucceeded();

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

  // The safety-net poll: approvals and failures arrive live with run events, permissions with session events.
  useEffect(() => {
    if (shell.connection !== 'ready') return;
    const refresh = (): void => {
      const connection = connectionRef.current;
      const projectId = projectRef.current;
      const hostId = configRef.current?.hostId;
      if (!connection || !projectId || !hostId) return;
      void connection.read<MobileAttentionItem[]>(readRequest('attention.list', { hostId, projectId }))
        .then(items => {
          setPolledAttention(items);
          refreshSucceeded();
        })
        .catch(error => refreshFailed('Refreshing attention', error));
    };
    const timer = setInterval(refresh, runsSupported ? ATTENTION_SAFETY_POLL_MS : ATTENTION_LEGACY_POLL_MS);
    return () => clearInterval(timer);
  }, [shell.connection, runsSupported]);

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
        .catch(error => {
          recordDiagnostic('Checking the desktop after returning to the app', error);
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

  const attention = useMemo(() => {
    const hostId = configRef.current?.hostId ?? host.hostId;
    const permissions = Object.values(snapshots).flatMap(snapshot => permissionItems(hostId, snapshot));
    const fromRuns = runsSupported ? runAttentionItems(hostId, project.projectId, workflowRuns) : undefined;
    return combineAttention({ polled: polledAttention, permissions, fromRuns, resolvedIds });
  }, [host.hostId, snapshots, runsSupported, project.projectId, workflowRuns, polledAttention, resolvedIds]);

  // Forget an acted-on item once the desktop no longer reports it, so a later request with the same id shows.
  useEffect(() => {
    if (resolvedIds.size === 0) return;
    const present = new Set(attention.map(item => item.id));
    if ([...resolvedIds].some(id => !present.has(id))) setResolvedIds(previous => new Set([...previous].filter(id => present.has(id))));
  }, [attention, resolvedIds]);

  const markResolved = useCallback((id: string) => setResolvedIds(previous => new Set(previous).add(id)), []);

  const value = useMemo<Store>(() => {
    const nav = (mutate: (state: MobileNavigationState) => MobileNavigationState): void =>
      setShell(previous => ({ ...previous, navigation: mutate(previous.navigation) }));
    const catalog = providers.value;
    const actions = createStoreActions({
      connectionRef, configRef, projectRef, hostInfoRef, phaseRef, commandsRef,
      host, providers, models,
      applySnapshot, setWork, setFollowUps, setOpenWorkId, setRuns, setUsageReads, setProviders, setModels, markResolved,
    });

    return {
      shell,
      autoConnectEnabled,
      host,
      hostInfo,
      hostConfig,
      project,
      work,
      attention,
      followUps,
      workflows,
      runs,
      workflowRuns,
      runsSupported,
      openWorkId,
      openRunId,
      connectionIssue,
      pairing,
      providers,
      models,
      access,
      activity: activityEntries(work, snapshots),
      ...actions,

      connect: config => {
        setAutoConnectEnabled(true);
        return openConnection(config, 'initial');
      },
      retryConnection: () => {
        const config = configRef.current;
        if (!config) return;
        setAutoConnectEnabled(true);
        reconnectAttemptRef.current = 0;
        void openConnection(config, phaseRef.current === 'reconnecting' ? 'reconnect' : 'initial');
      },
      cancelConnect: () => {
        clearReconnectTimer();
        closeConnection();
        setAutoConnectEnabled(false);
        setPairing(undefined);
        setPhase('offline');
      },
      disconnect: options => {
        clearReconnectTimer();
        closeConnection();
        forgetIdentityCheck();
        setAutoConnectEnabled(false);
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
        setPolledAttention([]);
        setResolvedIds(new Set());
        setFollowUps([]);
        setWorkflows([]);
        setRuns({});
        setWorkflowRuns([]);
        setRunsSupported(false);
        setOpenRunId(undefined);
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
          applyAppearance(undefined);
        }
      },
      setRoute: primary => nav(state => selectMobileRoute(state, primary)),
      setDetail: detail => nav(state => selectMobileDetail(state, detail)),
      openWork: workId => {
        setOpenWorkId(workId);
        if (workId) setOpenRunId(undefined);
      },
      openRun: runId => {
        setOpenRunId(runId);
        if (runId) {
          setOpenWorkId(undefined);
          nav(state => selectMobileDetail(selectMobileRoute(state, 'work'), 'chat'));
        }
      },
      sessionFor: sessionId => snapshots[sessionId],
      startNewChat: () => {
        setOpenRunId(undefined);
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
      updateDraftSelection: (workId, patch) => {
        setWork(previous => previous.map(item => item.workId === workId && item.draft
          ? { ...item, selection: { ...(item.selection ?? DEFAULT_SESSION_SELECTION), ...patch } }
          : item));
      },
    };
  }, [shell, autoConnectEnabled, host, hostInfo, hostConfig, project, work, attention, followUps, workflows, runs, workflowRuns, runsSupported, openWorkId, openRunId, connectionIssue, pairing, providers, models, access, snapshots, usageReads, applySnapshot, openConnection, setPhase, markResolved]);

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
