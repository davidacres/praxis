import React, { useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MobileSessionMode } from '@praxis/core';
import { AppHeader, Body, Button, Card, ConnectionBadge, Pill } from '../app/ui';
import { SvgXml } from 'react-native-svg';
import type { MobileMotifAnchor } from '@praxis/core';
import { currentAppearance, mobileScale, theme, themedStyles } from '../app/theme';
import { fitCornerMotifSvg, motifSpreadScale, tiledMotifSvg } from '../renderer/mobileTheme';
import { useStore } from '../app/store';
import { ChatMessage, Transcript, type TranscriptMessage } from '../app/Transcript';
import { ChangesView } from './ChangesView';
import { recordDiagnostic } from '../app/diagnostics';
import type { MobileFollowUp } from '../renderer/mobileFollowUp';
import {
  DEFAULT_SESSION_SELECTION,
  effectiveSelection,
  modelLabel,
  providerOption,
  validateSelection,
} from '../renderer/mobileSessionOptions';
import { SessionComposer, type ComposerModeOption } from './SessionComposer';
import { ProviderModelSheet } from './ProviderModelSheet';
import { formatClock } from '../renderer/mobileTime';
import { RunDetail } from './RunScreen';

export function WorkScreen({ onOpenSidebar }: { onOpenSidebar: () => void }): React.JSX.Element {
  const { work, openWorkId, openRunId, workflowRuns } = useStore();
  const run = openRunId ? workflowRuns.find(candidate => candidate.runId === openRunId) : undefined;
  if (run) return <RunDetail runId={run.runId} onOpenSidebar={onOpenSidebar} />;
  const open = work.find(item => item.workId === openWorkId);
  return open ? <WorkDetail workId={open.workId} onOpenSidebar={onOpenSidebar} /> : <EmptySession onOpenSidebar={onOpenSidebar} />;
}

/** Where a corner layer sits: flush with its corner, spilling off-screen the way the desktop's does. */
const CORNER_PLACEMENT: Record<Exclude<MobileMotifAnchor, 'center'>, object> = {
  'top-left': { top: 0, left: 0 },
  'top-right': { top: 0, right: 0 },
  'bottom-left': { bottom: 0, left: 0 },
  'bottom-right': { bottom: 0, right: 0 },
};

/**
 * The desktop's motif behind the conversation — the same SVG the desktop
 * paints, at the same size and corners. With no motif on the desktop there is
 * none here; only a desktop too old to send its theme gets the stock hexagons.
 */
export function MotifBackdrop(): React.JSX.Element {
  const appearance = currentAppearance();
  const [box, setBox] = useState({ width: 0, height: 0 });
  const motif = appearance?.motif;
  const scale = motif ? motifSpreadScale(motif, box.width, box.height) : 1;
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.hexBackdrop}
      onLayout={event => setBox({ width: event.nativeEvent.layout.width, height: event.nativeEvent.layout.height })}
    >
      {motif ? (
        <View style={[styles.motifLayers, { opacity: motif.opacity }]}>
          {motif.layers.map((layer, index) => layer.anchor === 'center' || layer.repeat
            ? box.width > 0 && <SvgXml key={index} xml={tiledMotifSvg(layer, box.width, box.height)} width={box.width} height={box.height} />
            : box.width > 0 && (() => {
              const corner = fitCornerMotifSvg(layer, scale);
              return (
                <View key={index} style={[styles.motifCorner, { width: corner.size, height: corner.size }, CORNER_PLACEMENT[layer.anchor]]}>
                  <SvgXml xml={corner.svg} width={corner.size} height={corner.size} />
                </View>
              );
            })())}
        </View>
      ) : !appearance ? <StockHexagons /> : null}
    </View>
  );
}

/** The phone's own hexagons, for a desktop that predates sending its theme. */
function StockHexagons(): React.JSX.Element {
  const rows = Array.from({ length: 17 }, (_, index) => index);
  return (
    <>
      {rows.map(row => (
        <Text key={row} numberOfLines={1} style={[styles.hexRow, row % 2 === 1 && styles.hexRowOffset]}>
          {'⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡'}
        </Text>
      ))}
      <View style={styles.hexShade} />
    </>
  );
}

function EmptySession({ onOpenSidebar }: { onOpenSidebar: () => void }): React.JSX.Element {
  return (
    <View style={styles.detailShell}>
      <MotifBackdrop />
      <AppHeader title="Sessions" onOpenSidebar={onOpenSidebar} />
      <View style={styles.emptySession}>
        <Text style={styles.emptyTitle}>Choose a session</Text>
        <Text style={styles.emptyText}>Open a previous session or start a new chat from the sidebar.</Text>
      </View>
    </View>
  );
}

export function SessionHeader({ title, onOpenSidebar }: {
  title: string;
  onOpenSidebar: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.header}>
      <View style={styles.headerTop}>
        <Pressable accessibilityRole="button" accessibilityLabel="Open navigation" hitSlop={8} onPress={onOpenSidebar} style={styles.menuButton}>
          <Text style={styles.menuGlyph}>☰</Text>
        </Pressable>
        <Text numberOfLines={1} style={styles.headerTitle}>{title}</Text>
        <ConnectionBadge />
      </View>
    </View>
  );
}

/**
 * Space the keyboard covers above the bottom safe area. KeyboardAvoidingView
 * under the app's SafeAreaView left the composer's controls (model chips, Send)
 * behind the keyboard, so the inset is taken from the keyboard frame directly.
 */
function useKeyboardInset(): number {
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const shown = Keyboard.addListener(showEvent, event => setHeight(event.endCoordinates.height));
    // Overlap with the window, so a keyboard moving off-screen counts as zero.
    const frame = Keyboard.addListener('keyboardWillChangeFrame', event => {
      setHeight(Math.max(0, Dimensions.get('window').height - event.endCoordinates.screenY));
    });
    const hidden = Keyboard.addListener(hideEvent, () => setHeight(0));
    return () => {
      shown.remove();
      frame.remove();
      hidden.remove();
    };
  }, []);
  return Math.max(0, height - insets.bottom);
}

const UNSUPPORTED_MODES: ComposerModeOption[] = [
  { mode: 'chat', available: true },
  { mode: 'analysis', available: false, unavailableMessage: 'Choosing a mode from the phone needs a newer Praxis desktop.' },
  { mode: 'review', available: false, unavailableMessage: 'Choosing a mode from the phone needs a newer Praxis desktop.' },
];

type TranscriptItem =
  | { kind: 'message'; key: string; message: TranscriptMessage }
  | { kind: 'followUp'; key: string; followUp: MobileFollowUp };

/** A message the phone sent that the desktop has not taken yet — sending, or failed with Retry. */
function PendingFollowUp({ followUp, canRetry, onRetry }: { followUp: MobileFollowUp; canRetry: boolean; onRetry: () => void }): React.JSX.Element {
  return (
    <>
      <ChatMessage message={{ id: followUp.messageId, author: 'user', text: followUp.text, at: formatClock(followUp.createdAt), streaming: false }} />
      {followUp.state === 'failed' ? (
        <View accessibilityRole="alert" style={[styles.message, styles.messageFailed]}>
          <Text style={styles.messageAuthor}>NOT SENT</Text>
          <Text style={styles.messageText}>{followUp.result ?? 'The desktop did not accept this message.'}</Text>
          <Button label="Retry" kind="ghost" disabled={!canRetry} onPress={onRetry} />
        </View>
      ) : (
        <View style={[styles.message, styles.messageAssistant]}>
          <View style={styles.messageHeader}>
            <Text style={styles.messageAuthor}>AI AGENT</Text>
            <Text style={styles.messageTime}>SENDING</Text>
          </View>
          <Text style={[styles.messageText, styles.messagePending]}>Sending to the desktop…</Text>
        </View>
      )}
    </>
  );
}

function WorkDetail({ workId, onOpenSidebar }: { workId: string; onOpenSidebar: () => void }): React.JSX.Element {
  const {
    work, shell, host, transcriptFor, followUps, workflows, runs, workflowRuns, sendFollowUp, retryFollowUp, cancelSession, startWorkflow, loadRun, answerGadget,
    providers, models, loadModels, refreshProviders, updateDraftSelection, usageFor, refreshUsage, hostInfo, configureSession, sessionFor,
  } = useStore();
  const [pendingHandover, setPendingHandover] = useState<string | undefined>(undefined);
  const [configuring, setConfiguring] = useState(false);
  const [pickerError, setPickerError] = useState<string | undefined>(undefined);
  const item = work.find(entry => entry.workId === workId)!;
  const detail = shell.navigation.detail;
  const keyboardInset = useKeyboardInset();
  const [draft, setDraft] = useState('');
  const [composerError, setComposerError] = useState<string | undefined>(undefined);
  const [picker, setPicker] = useState<'provider' | 'model' | undefined>(undefined);
  const itemFollowUps = followUps.filter(message => message.workId === workId);
  const run = item.runId ? runs[item.runId] : undefined;
  const session = sessionFor(item.sessionId);
  const messages = transcriptFor(item.sessionId);

  const catalog = providers.value;
  const selection = item.draft ? effectiveSelection(catalog, item.selection ?? DEFAULT_SESSION_SELECTION, models[item.selection?.provider ?? '']?.value) : undefined;
  const providerId = item.draft ? selection?.provider : item.provider;
  const option = providerOption(catalog, providerId);
  const providerModels = providerId ? models[providerId] : undefined;
  const providerLabel = option?.label
    ?? providerId
    ?? (providers.status === 'loading' || providers.status === 'idle' ? 'Loading…' : providers.status === 'unsupported' ? 'Desktop default' : 'No provider');
  const shownModel = item.draft
    ? modelLabel(providerModels?.value, selection?.model, option?.defaultModel)
    : item.model ? modelLabel(providerModels?.value, item.model) : 'Provider default';
  const model = session?.model ?? (item.draft ? selection?.model : item.model);
  const mode: MobileSessionMode = item.draft ? selection?.mode ?? 'chat' : item.mode;
  const modeOptions: readonly ComposerModeOption[] = catalog?.sessionModes ?? UNSUPPORTED_MODES;
  const canConfigure = Boolean(hostInfo?.commandOperations.includes('sessions.configure'));
  const turnRunning = item.status === 'active' || itemFollowUps.some(message => message.state === 'pending');
  const lockedReason = item.draft
    ? undefined
    : !canConfigure ? 'This desktop cannot change a running session’s provider or model from the phone. Update Praxis on the desktop, or start a new chat.'
    : shell.connection !== 'ready' ? 'Reconnect to the desktop to change the provider or model.'
    : turnRunning ? 'Wait for the current turn to finish, then change the provider, model or mode.'
    : undefined;
  const editable = Boolean(item.draft) || lockedReason === undefined;
  const closePicker = (): void => {
    setPicker(undefined);
    setPendingHandover(undefined);
    setPickerError(undefined);
  };
  const applyChange = (change: { provider?: string; model?: string; mode?: MobileSessionMode }): void => {
    setConfiguring(true);
    setPickerError(undefined);
    void configureSession(item, change)
      .then(() => closePicker())
      .catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        if (picker) setPickerError(message);
        else setComposerError(message);
      })
      .finally(() => setConfiguring(false));
  };
  const verdict = item.draft ? validateSelection(catalog, selection ?? DEFAULT_SESSION_SELECTION, providerId ? providerModels?.value : undefined) : { ok: true as const };
  const blockedReason = shell.connection === 'reconnecting'
    ? `Reconnecting to ${host.hostName || 'the desktop'}… you can send again once it is back.`
    : !verdict.ok ? verdict.message : undefined;

  // The run's progress is re-read when its live snapshot moves on, not on a timer.
  const runSequence = item.runId ? workflowRuns.find(candidate => candidate.runId === item.runId)?.sequence : undefined;
  useEffect(() => {
    if (detail === 'chat' || !item.runId) return;
    void loadRun(item.runId).catch(error => recordDiagnostic('Loading workflow progress', error));
  }, [detail, item.runId, runSequence, loadRun]);

  const transcriptItems = React.useMemo<TranscriptItem[]>(() => [
    ...messages.map(message => ({ kind: 'message' as const, key: message.id, message })),
    ...itemFollowUps.map(followUp => ({ kind: 'followUp' as const, key: followUp.messageId, followUp })),
  ], [messages, itemFollowUps]);

  // Show the model by name (and validate a draft's choice), so load the provider's list once.
  useEffect(() => {
    if (providerId && !models[providerId] && shell.connection === 'ready' && (item.draft || canConfigure)) void loadModels(providerId);
  }, [item.draft, canConfigure, providerId, models, loadModels, shell.connection]);

  // When a turn finishes, re-read the desktop's totals (the stream already carries them; this confirms).
  const previousStatus = useRef(item.status);
  useEffect(() => {
    if (!item.draft && previousStatus.current === 'active' && item.status !== 'active') void refreshUsage(item.sessionId).catch(error => recordDiagnostic('Refreshing usage', error));
    previousStatus.current = item.status;
  }, [item.draft, item.sessionId, item.status, refreshUsage]);

  const send = (): void => {
    const text = draft.trim();
    if (!text) return;
    setComposerError(undefined);
    setDraft('');
    void sendFollowUp(item, text).catch(error => {
      setDraft(text);
      setComposerError(error instanceof Error ? error.message : String(error));
    });
  };

  return (
    <View style={[styles.detailShell, { paddingBottom: keyboardInset }]}>
      <MotifBackdrop />
      <SessionHeader title={item.title} onOpenSidebar={onOpenSidebar} />

      {detail === 'chat' ? (
        <>
          <Transcript
            data={transcriptItems}
            keyOf={entry => entry.key}
            resetKey={item.workId}
            header={item.draft && messages.length === 0 && itemFollowUps.length === 0 ? (
              <View style={styles.draftIntro}>
                <Text style={styles.emptyTitle}>New chat</Text>
                <Text style={styles.emptyText}>Choose the provider, model and mode below, then send your first message. The session runs on {host.hostName || 'the desktop'}.</Text>
              </View>
            ) : null}
            renderItem={entry => entry.kind === 'message' ? (
              <ChatMessage
                message={{
                  ...entry.message,
                  model: entry.message.model ?? (entry.message.author === 'assistant' ? model : undefined),
                  tokens: entry.message.tokens ?? (entry.message.author === 'assistant' ? session?.tokenUsage : undefined),
                  cost: entry.message.cost ?? (entry.message.author === 'assistant' ? session?.cost : undefined),
                }}
                connected={shell.connection === 'ready'}
                onAnswer={(gadget, action, value) => answerGadget(item.sessionId, gadget, action, value)}
              />
            ) : (
              <PendingFollowUp followUp={entry.followUp} canRetry={shell.connection === 'ready'} onRetry={() => void retryFollowUp(entry.followUp.messageId)} />
            )}
          />
          <SessionComposer
            value={draft}
            onChange={setDraft}
            onSend={send}
            onStop={item.draft ? undefined : () => void cancelSession(item.sessionId).catch(error => setComposerError(error instanceof Error ? error.message : String(error)))}
            sending={item.status === 'active' || itemFollowUps.some(message => message.state === 'pending')}
            blockedReason={blockedReason}
            error={composerError}
            editable={editable}
            draft={Boolean(item.draft)}
            lockedReason={lockedReason}
            providerLabel={providerLabel}
            modelLabel={shownModel}
            mode={mode}
            onOpenProviderPicker={() => {
              setPicker('provider');
              if (!catalog) void refreshProviders();
            }}
            onOpenModelPicker={() => {
              setPicker('model');
              if (providerId && !models[providerId]) void loadModels(providerId);
            }}
            modeOptions={modeOptions}
            onChangeMode={next => item.draft ? updateDraftSelection(item.workId, { mode: next }) : applyChange({ mode: next })}
            usage={usageFor(item)}
            onRefreshUsage={item.draft ? undefined : () => void refreshUsage(item.sessionId).catch(error => recordDiagnostic('Refreshing usage', error))}
            workflows={workflows}
            onStartWorkflow={shell.connection === 'ready'
              ? workflowId => void startWorkflow(workflowId, item.title).catch(error => setComposerError(error instanceof Error ? error.message : String(error)))
              : undefined}
          />
          <ProviderModelSheet
            kind={picker}
            providers={providers}
            models={providerModels}
            selectedProvider={providerId}
            selectedModel={item.draft ? selection?.model : item.model}
            providerLabel={providerLabel}
            allowDefault={Boolean(item.draft)}
            busy={configuring}
            {...(pickerError ? { error: pickerError } : {})}
            {...(pendingHandover ? {
              confirm: {
                title: `Hand over to ${providerOption(catalog, pendingHandover)?.label ?? pendingHandover}?`,
                body: `The desktop sends ${providerOption(catalog, pendingHandover)?.label ?? pendingHandover} a handover brief of this session (progress, changes, decisions and next steps) and starts a turn with it, using its default model. You can pick a different model afterwards. This is the same handover as on the desktop.`,
                confirmLabel: 'Hand over',
                onConfirm: () => applyChange({ provider: pendingHandover }),
                onCancel: () => setPendingHandover(undefined),
              },
            } : {})}
            onSelectProvider={provider => {
              if (item.draft) {
                updateDraftSelection(item.workId, { provider, model: undefined });
                closePicker();
              } else if (provider === item.provider) {
                closePicker();
              } else {
                setPendingHandover(provider);
              }
            }}
            onSelectModel={model => {
              if (item.draft) {
                updateDraftSelection(item.workId, { ...(providerId ? { provider: providerId } : {}), model });
                closePicker();
              } else if (!model || model === item.model) {
                closePicker();
              } else {
                applyChange({ model });
              }
            }}
            onRefresh={() => {
              if (picker === 'model' && providerId) void loadModels(providerId, true);
              else void refreshProviders();
            }}
            onClose={closePicker}
          />
        </>
      ) : (
        <ScrollView contentContainerStyle={styles.detailContent}>
          {detail === 'progress' && (
            <Card>
              <Body dim>{run ? `${run.workflowName} · ${run.status}` : item.runId ? 'Loading workflow progress…' : 'No workflow run is attached to this session.'}</Body>
              {run?.stages.map(stage => (
                <View key={stage.nodeId} style={styles.rowBetween}>
                  <Body>{stage.name}</Body>
                  <Pill label={stage.outcome} tone={stage.outcome === 'succeeded' ? 'ok' : stage.lane === 'awaiting' ? 'warn' : 'neutral'} />
                </View>
              ))}
              {run ? <Body dim>{run.explanation}</Body> : null}
            </Card>
          )}

          {detail === 'changes' && (item.draft
            ? <Card><Body dim>Send the first message to start a session; its changes appear here.</Body></Card>
            : <ChangesView sessionId={item.sessionId} {...(item.runId ? { runId: item.runId } : {})} {...(run ? { run } : {})} />)}
        </ScrollView>
      )}
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  detailShell: { flex: 1, backgroundColor: theme.bg },
  hexBackdrop: { position: 'absolute', inset: 0, overflow: 'hidden', backgroundColor: theme.bg },
  hexRow: {
    height: mobileScale(48),
    marginTop: -5,
    marginLeft: -26,
    color: theme.accent,
    opacity: 0.09,
    fontSize: mobileScale(41),
    lineHeight: mobileScale(48),
    letterSpacing: -3,
  },
  hexRowOffset: { marginLeft: 1 },
  motifLayers: { position: 'absolute', inset: 0 },
  motifCorner: { position: 'absolute' },
  hexShade: { position: 'absolute', inset: 0, backgroundColor: theme.hexShade },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  header: { borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: theme.chrome },
  headerTop: { minHeight: mobileScale(48), paddingHorizontal: mobileScale(10), flexDirection: 'row', alignItems: 'center', gap: mobileScale(9) },
  menuButton: {
    width: mobileScale(30),
    height: mobileScale(30),
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: mobileScale(6),
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  menuGlyph: { color: theme.textSecondary, fontSize: mobileScale(15), lineHeight: mobileScale(17) },
  headerTitle: { flex: 1, minWidth: 0, color: theme.text, fontSize: mobileScale(14), fontWeight: '700' },
  transcript: { flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: mobileScale(12), paddingTop: mobileScale(14), paddingBottom: mobileScale(8) },
  message: {
    marginBottom: mobileScale(12),
    paddingHorizontal: mobileScale(12),
    paddingTop: mobileScale(9),
    paddingBottom: mobileScale(11),
    borderWidth: 1,
    borderRadius: mobileScale(7),
  },
  messageUser: { alignSelf: 'flex-end', maxWidth: '85%', borderColor: theme.accentMuted, backgroundColor: theme.userMessage },
  messageAssistant: { alignSelf: 'stretch', width: '100%', maxWidth: '100%', borderColor: theme.border, backgroundColor: theme.assistantMessage },
  messageHeader: { marginBottom: mobileScale(7), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: mobileScale(18) },
  messageAuthor: { color: theme.textDim, fontSize: mobileScale(10), fontWeight: '700', letterSpacing: 0.8 },
  messageTime: { color: theme.textDim, fontSize: mobileScale(10), fontVariant: ['tabular-nums'] },
  messageText: { color: theme.text, fontSize: mobileScale(13), lineHeight: mobileScale(19) },
  notice: { alignSelf: 'center', maxWidth: '90%', marginBottom: mobileScale(12), paddingHorizontal: mobileScale(10), paddingVertical: mobileScale(4), borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, backgroundColor: theme.surface },
  noticeText: { color: theme.textDim, fontSize: mobileScale(11), textAlign: 'center' },
  messagePending: { color: theme.textDim, fontStyle: 'italic' },
  messageFailed: { alignSelf: 'flex-start', gap: mobileScale(8), borderColor: theme.danger, backgroundColor: theme.dangerSoft },
  draftIntro: { paddingVertical: mobileScale(24), alignItems: 'center' },
  detailContent: { flexGrow: 1, padding: theme.space, gap: theme.space },
  emptySession: { flex: 1, padding: 28, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: theme.text, fontSize: mobileScale(18), fontWeight: '700' },
  emptyText: { maxWidth: mobileScale(260), marginTop: mobileScale(7), color: theme.textDim, fontSize: mobileScale(12), lineHeight: mobileScale(18), textAlign: 'center' },
}));
