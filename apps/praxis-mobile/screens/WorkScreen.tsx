import React, { useEffect, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AppHeader, Body, Button, Card, Pill } from '../app/ui';
import { theme } from '../app/theme';
import { useStore } from '../app/store';
import type { MobileDetailTab } from '../renderer/mobileNavigation';
import { DEMO_RUN, type DemoTranscriptMessage } from '../app/demoData';
import { SessionComposer } from './SessionComposer';

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

function ChatMessage({ message }: { message: DemoTranscriptMessage }): React.JSX.Element {
  const user = message.author === 'user';
  return (
    <View style={[styles.message, user ? styles.messageUser : styles.messageAssistant]}>
      <View style={styles.messageHeader}>
        <Text style={styles.messageAuthor}>{user ? 'YOU' : 'AI AGENT'}</Text>
        <View style={styles.messageMeta}>
          <Text style={styles.messageTime}>{message.at}</Text>
          <Text style={styles.copyGlyph}>▢</Text>
        </View>
      </View>
      <Text style={styles.messageText}>{message.text}</Text>
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
        <View style={styles.livePill}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE</Text>
        </View>
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

function WorkDetail({ workId, onOpenSidebar }: { workId: string; onOpenSidebar: () => void }): React.JSX.Element {
  const { work, shell, setDetail, transcriptFor, followUps, sendFollowUp, approve } = useStore();
  const item = work.find(entry => entry.workId === workId)!;
  const detail = shell.navigation.detail;
  const [draft, setDraft] = useState('');
  const transcriptRef = useRef<ScrollView | null>(null);
  const itemFollowUps = followUps.filter(message => message.workId === workId);

  useEffect(() => {
    if (detail !== 'chat') return;
    const timer = setTimeout(() => transcriptRef.current?.scrollToEnd({ animated: true }), 80);
    return () => clearTimeout(timer);
  }, [detail, itemFollowUps.length]);

  const send = (): void => {
    const text = draft.trim();
    if (!text) return;
    sendFollowUp(item, text);
    setDraft('');
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={0} style={styles.detailShell}>
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
            {transcriptFor(item.sessionId).map(message => <ChatMessage key={message.id} message={message} />)}
            {itemFollowUps.map(message => (
              <React.Fragment key={message.messageId}>
                <ChatMessage
                  message={{
                    id: message.messageId,
                    author: 'user',
                    text: message.text,
                    at: new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                  }}
                />
                <View style={[styles.message, styles.messageAssistant]}>
                  <View style={styles.messageHeader}>
                    <Text style={styles.messageAuthor}>AI AGENT</Text>
                    <Text style={styles.messageTime}>{message.state === 'completed' ? 'NOW' : 'WORKING'}</Text>
                  </View>
                  <Text style={[styles.messageText, message.state !== 'completed' && styles.messagePending]}>
                    {message.state === 'completed' ? (message.result ?? 'Done.') : 'Thinking…'}
                  </Text>
                </View>
              </React.Fragment>
            ))}
          </ScrollView>
          <SessionComposer
            value={draft}
            onChange={setDraft}
            onSend={send}
            sending={itemFollowUps.some(message => message.state === 'pending')}
          />
        </>
      ) : (
        <ScrollView contentContainerStyle={styles.detailContent}>
          {detail === 'progress' && (
            <Card>
              <Body dim>{DEMO_RUN.workflowName} · {DEMO_RUN.status}</Body>
              {DEMO_RUN.stages.map(stage => (
                <View key={stage.nodeId} style={styles.rowBetween}>
                  <Body>{stage.name}</Body>
                  <Pill label={stage.outcome} tone={stage.outcome === 'succeeded' ? 'ok' : stage.outcome === 'awaiting' ? 'warn' : 'neutral'} />
                </View>
              ))}
              {DEMO_RUN.status === 'awaiting-approval' && item.status !== 'Approved' && (
                <Button label="Approve" onPress={() => approve(DEMO_RUN.runId)} />
              )}
            </Card>
          )}

          {detail === 'changes' && (
            <Card>
              {DEMO_RUN.changes.map(file => (
                <View key={file.path} style={styles.rowBetween}>
                  <Body>{file.path}</Body>
                  <Body dim>+{file.added} −{file.removed}</Body>
                </View>
              ))}
            </Card>
          )}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
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
  hexShade: { position: 'absolute', inset: 0, backgroundColor: 'rgba(7, 15, 24, 0.18)' },
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  header: { borderBottomWidth: 1, borderBottomColor: theme.border, backgroundColor: 'rgba(9, 16, 24, 0.95)' },
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
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.ok },
  liveText: { color: theme.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.8 },
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
  messageMeta: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  messageTime: { color: theme.textDim, fontSize: 10, fontVariant: ['tabular-nums'] },
  copyGlyph: { color: theme.textDim, opacity: 0.7, fontSize: 11 },
  messageText: { color: theme.text, fontSize: 13, lineHeight: 19 },
  messagePending: { color: theme.textDim, fontStyle: 'italic' },
  detailContent: { flexGrow: 1, padding: theme.space, gap: theme.space },
  emptySession: { flex: 1, padding: 28, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: theme.text, fontSize: 18, fontWeight: '700' },
  emptyText: { maxWidth: 260, marginTop: 7, color: theme.textDim, fontSize: 12, lineHeight: 18, textAlign: 'center' },
});
