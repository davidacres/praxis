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
import { theme } from '../app/theme';
import { useStore, type MobileTranscriptMessage } from '../app/store';
import type { MobileDetailTab } from '../renderer/mobileNavigation';
import {
  DEFAULT_SESSION_SELECTION,
  effectiveSelection,
  modelLabel,
  providerOption,
  validateSelection,
} from '../renderer/mobileSessionOptions';
import { SessionComposer, type ComposerModeOption } from './SessionComposer';
import { ProviderModelSheet } from './ProviderModelSheet';

const DETAIL_TABS: MobileDetailTab[] = ['chat', 'progress', 'changes'];

export function WorkScreen({ onOpenSidebar }: { onOpenSidebar: () => void }): React.JSX.Element {
  const { work, openWorkId } = useStore();
  const open = work.find(item => item.workId === openWorkId);
  return open ? <WorkDetail workId={open.workId} onOpenSidebar={onOpenSidebar} /> : <EmptySession onOpenSidebar={onOpenSidebar} />;
}

function HexBackdrop(): React.JSX.Element {
  const rows = Array.from({ length: 17 }, (_, index) => index);
  return (
    <View
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.hexBackdrop}
    >
      {rows.map(row => (
        <Text key={row} numberOfLines={1} style={[styles.hexRow, row % 2 === 1 && styles.hexRowOffset]}>
          {'⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡  ⬡'}
        </Text>
      ))}
      <View style={styles.hexShade} />
    </View>
  );
}

function EmptySession({ onOpenSidebar }: { onOpenSidebar: () => void }): React.JSX.Element {
  return (
    <View style={styles.detailShell}>
      <HexBackdrop />
      <AppHeader title="Sessions" onOpenSidebar={onOpenSidebar} />
      <View style={styles.emptySession}>
        <Text style={styles.emptyTitle}>Choose a session</Text>
        <Text style={styles.emptyText}>Open a previous session or start a new chat from the sidebar.</Text>
      </View>
    </View>
  );
}

function ChatMessage({ message }: { message: MobileTranscriptMessage }): React.JSX.Element {
  if (message.author === 'system') {
    return (
      <View accessibilityRole="text" style={styles.notice}>
        <Text style={styles.noticeText}>{message.text} · {message.at}</Text>
      </View>
    );
  }
  const user = message.author === 'user';
  return (
    <View style={[styles.message, user ? styles.messageUser : styles.messageAssistant]}>
      <View style={styles.messageHeader}>
        <Text style={styles.messageAuthor}>{user ? 'YOU' : 'AI AGENT'}</Text>
        <Text style={styles.messageTime}>{message.streaming ? 'STREAMING' : message.at}</Text>
      </View>
      <Text selectable style={styles.messageText}>{message.text}</Text>
    </View>
  );
}

function SessionHeader({
  title,
  detail,
  onOpenSidebar,
  onSelectDetail,
}: {
  title: string;
  detail: MobileDetailTab;
  onOpenSidebar: () => void;
  onSelectDetail: (detail: MobileDetailTab) => void;
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
      <View accessibilityRole="tablist" style={styles.detailTabs}>
        {DETAIL_TABS.map(tab => {
          const selected = detail === tab;
          return (
            <Pressable
              key={tab}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => onSelectDetail(tab)}
              style={[styles.detailTab, selected && styles.detailTabActive]}
            >
              <Text style={[styles.detailTabText, selected && styles.detailTabTextActive]}>
                {tab[0]!.toUpperCase() + tab.slice(1)}
              </Text>
            </Pressable>
          );
        })}
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

function WorkDetail({ workId, onOpenSidebar }: { workId: string; onOpenSidebar: () => void }): React.JSX.Element {
  const {
    work, shell, host, setDetail, transcriptFor, followUps, workflows, runs, sendFollowUp, retryFollowUp, cancelSession, startWorkflow, loadRun,
    providers, models, loadModels, refreshProviders, updateDraftSelection, usageFor, refreshUsage, hostInfo, configureSession,
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
  const transcriptRef = useRef<ScrollView | null>(null);
  const itemFollowUps = followUps.filter(message => message.workId === workId);
  const run = item.runId ? runs[item.runId] : undefined;
  const messages = transcriptFor(item.sessionId);
  const lastLength = messages[messages.length - 1]?.text.length ?? 0;

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

  useEffect(() => {
    if (detail !== 'chat') return;
    const timer = setTimeout(() => transcriptRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [detail, itemFollowUps.length, messages.length, lastLength]);

  useEffect(() => {
    if (detail === 'chat' || !item.runId) return;
    void loadRun(item.runId);
    const timer = setInterval(() => void loadRun(item.runId!), 3_000);
    return () => clearInterval(timer);
  }, [detail, item.runId, loadRun]);

  // Show the model by name (and validate a draft's choice), so load the provider's list once.
  useEffect(() => {
    if (providerId && !models[providerId] && shell.connection === 'ready' && (item.draft || canConfigure)) void loadModels(providerId);
  }, [item.draft, canConfigure, providerId, models, loadModels, shell.connection]);

  // When a turn finishes, re-read the desktop's totals (the stream already carries them; this confirms).
  const previousStatus = useRef(item.status);
  useEffect(() => {
    if (!item.draft && previousStatus.current === 'active' && item.status !== 'active') void refreshUsage(item.sessionId).catch(() => undefined);
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
      <HexBackdrop />
      <SessionHeader title={item.title} detail={detail} onOpenSidebar={onOpenSidebar} onSelectDetail={setDetail} />

      {detail === 'chat' ? (
        <>
          <ScrollView
            ref={transcriptRef}
            contentContainerStyle={styles.transcript}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          >
            {item.draft && messages.length === 0 && itemFollowUps.length === 0 ? (
              <View style={styles.draftIntro}>
                <Text style={styles.emptyTitle}>New chat</Text>
                <Text style={styles.emptyText}>Choose the provider, model and mode below, then send your first message. The session runs on {host.hostName || 'the desktop'}.</Text>
              </View>
            ) : null}
            {messages.map(message => <ChatMessage key={message.id} message={message} />)}
            {itemFollowUps.map(message => (
              <React.Fragment key={message.messageId}>
                <ChatMessage
                  message={{
                    id: message.messageId,
                    author: 'user',
                    text: message.text,
                    at: new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                    streaming: false,
                  }}
                />
                {message.state === 'failed' ? (
                  <View accessibilityRole="alert" style={[styles.message, styles.messageFailed]}>
                    <Text style={styles.messageAuthor}>NOT SENT</Text>
                    <Text style={styles.messageText}>{message.result ?? 'The desktop did not accept this message.'}</Text>
                    <Button label="Retry" kind="ghost" disabled={shell.connection !== 'ready'} onPress={() => void retryFollowUp(message.messageId)} />
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
              </React.Fragment>
            ))}
          </ScrollView>
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
            onRefreshUsage={item.draft ? undefined : () => void refreshUsage(item.sessionId).catch(() => undefined)}
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

          {detail === 'changes' && (
            <Card>
              {!item.runId ? <Body dim>No workflow run is attached to this session.</Body> : null}
              {item.runId && !run ? <Body dim>Loading workflow artifacts…</Body> : null}
              {run && run.stages.every(stage => stage.artifacts.length === 0) ? <Body dim>No workflow artifacts have been produced yet.</Body> : null}
              {run?.stages.flatMap(stage => stage.artifacts.map(artifact => (
                <View key={`${stage.nodeId}:${artifact.contractId}:${artifact.path ?? artifact.kind}`} style={styles.rowBetween}>
                  <Body>{artifact.path ?? artifact.contractId}</Body>
                  <Body dim>{artifact.kind}</Body>
                </View>
              )))}
            </Card>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  detailShell: { flex: 1, backgroundColor: theme.bg },
  hexBackdrop: { position: 'absolute', inset: 0, overflow: 'hidden', backgroundColor: theme.bg },
  hexRow: {
    height: 48,
    marginTop: -5,
    marginLeft: -26,
    color: theme.accent,
    opacity: 0.09,
    fontSize: 41,
    lineHeight: 48,
    letterSpacing: -3,
  },
  hexRowOffset: { marginLeft: 1 },
  hexShade: { position: 'absolute', inset: 0, backgroundColor: theme.hexShade },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  header: { borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: theme.chrome },
  headerTop: { minHeight: 48, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 9 },
  menuButton: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  menuGlyph: { color: theme.textSecondary, fontSize: 15, lineHeight: 17 },
  headerTitle: { flex: 1, minWidth: 0, color: theme.text, fontSize: 14, fontWeight: '700' },
  detailTabs: { height: 32, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'flex-end', gap: 18 },
  detailTab: { height: 32, justifyContent: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  detailTabActive: { borderBottomColor: theme.accent },
  detailTabText: { color: theme.textDim, fontSize: 11, fontWeight: '600' },
  detailTabTextActive: { color: theme.text },
  transcript: { flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: 12, paddingTop: 14, paddingBottom: 8 },
  message: {
    maxWidth: '88%',
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingTop: 9,
    paddingBottom: 11,
    borderWidth: 1,
    borderRadius: 7,
  },
  messageUser: { alignSelf: 'flex-end', borderColor: theme.accentMuted, backgroundColor: theme.userMessage },
  messageAssistant: { alignSelf: 'flex-start', borderColor: theme.border, backgroundColor: theme.assistantMessage },
  messageHeader: { marginBottom: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 18 },
  messageAuthor: { color: theme.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  messageTime: { color: theme.textDim, fontSize: 10, fontVariant: ['tabular-nums'] },
  messageText: { color: theme.text, fontSize: 13, lineHeight: 19 },
  notice: { alignSelf: 'center', maxWidth: '90%', marginBottom: 12, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, backgroundColor: theme.surface },
  noticeText: { color: theme.textDim, fontSize: 11, textAlign: 'center' },
  messagePending: { color: theme.textDim, fontStyle: 'italic' },
  messageFailed: { alignSelf: 'flex-start', gap: 8, borderColor: theme.danger, backgroundColor: theme.dangerSoft },
  draftIntro: { paddingVertical: 24, alignItems: 'center' },
  detailContent: { flexGrow: 1, padding: theme.space, gap: theme.space },
  emptySession: { flex: 1, padding: 28, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: theme.text, fontSize: 18, fontWeight: '700' },
  emptyText: { maxWidth: 260, marginTop: 7, color: theme.textDim, fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
