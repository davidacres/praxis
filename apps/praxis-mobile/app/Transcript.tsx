import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import type { MobileGadgetView } from '@praxis/core';
import { followOnMessages, followOnScroll, initialFollowState, jumpLabel } from '../renderer/mobileTranscriptFollow';
import { GadgetView, type GadgetAnswer } from './GadgetView';
import { Markdown, markdownPlainText } from './Markdown';
import { mobileScale, theme, themedStyles } from './theme';

export interface TranscriptMessage {
  id: string;
  /** `system`: runtime notices (handover, model change) and errors. */
  author: 'user' | 'assistant' | 'system';
  text: string;
  at: string;
  streaming: boolean;
  gadgets?: readonly MobileGadgetView[];
}

/**
 * One message. The agent's words are markdown; a user's are shown as typed.
 * Gadgets the message asked for follow its prose, answerable in place.
 */
export const ChatMessage = React.memo(function ChatMessage({
  message,
  connected = false,
  onAnswer,
}: {
  message: TranscriptMessage;
  connected?: boolean;
  onAnswer?: GadgetAnswer;
}): React.JSX.Element {
  if (message.author === 'system') {
    return (
      <View accessibilityRole="text" style={styles.notice}>
        <Text style={styles.noticeText}>{message.text} · {message.at}</Text>
      </View>
    );
  }
  const user = message.author === 'user';
  return (
    <View style={styles.messageGroup}>
      {message.text ? (
        <View
          style={[styles.message, user ? styles.messageUser : styles.messageAssistant]}
          accessibilityLabel={`${user ? 'You' : 'Agent'}: ${user ? message.text : markdownPlainText(message.text)}`}
        >
          <View style={styles.messageHeader}>
            <Text style={styles.messageAuthor}>{user ? 'YOU' : 'AI AGENT'}</Text>
            <Text style={styles.messageTime}>{message.streaming ? 'STREAMING' : message.at}</Text>
          </View>
          {user ? <Text selectable style={styles.messageText}>{message.text}</Text> : <Markdown text={message.text} />}
        </View>
      ) : null}
      {message.gadgets?.map(view => (
        <GadgetView
          key={view.gadget.gadgetId}
          view={view}
          connected={connected}
          onAnswer={onAnswer ?? (async () => { throw new Error('Answer this on the desktop.'); })}
        />
      ))}
    </View>
  );
});

/**
 * A conversation as a virtualised, inverted list: only what is on screen is
 * mounted, the newest message sits at the bottom, and it follows new output
 * only while the reader is at the bottom. Scrolled up, the reader stays put and
 * a chip counts what arrived, with a tap back to the latest.
 */
export function Transcript<T>({
  data,
  keyOf,
  renderItem,
  header,
  resetKey,
}: {
  /** Oldest first, as the conversation reads. */
  data: readonly T[];
  keyOf: (item: T) => string;
  renderItem: (item: T) => React.ReactElement | null;
  /** Shown above the first message (the list is inverted, so it is the list's footer). */
  header?: React.ReactElement | null;
  /** Changing it (another session or stage) returns to the latest message. */
  resetKey?: string;
}): React.JSX.Element {
  const listRef = useRef<FlatList<T>>(null);
  const [follow, setFollow] = useState(() => initialFollowState(data.length));
  const reversed = React.useMemo(() => [...data].reverse(), [data]);

  useEffect(() => setFollow(current => followOnMessages(current, data.length)), [data.length]);
  useEffect(() => {
    setFollow(initialFollowState(data.length));
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    // Only a different conversation resets; its length is read once here.
  }, [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const offset = event.nativeEvent.contentOffset.y;
    setFollow(current => followOnScroll(current, offset, data.length));
  }, [data.length]);

  const jump = (): void => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
    setFollow(initialFollowState(data.length));
  };

  return (
    <View style={styles.shell}>
      <FlatList
        ref={listRef}
        inverted
        data={reversed}
        keyExtractor={keyOf}
        renderItem={({ item }) => renderItem(item)}
        ListFooterComponent={header ?? null}
        contentContainerStyle={styles.transcript}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        onScroll={onScroll}
        scrollEventThrottle={64}
        // Keeps the reader's place when messages arrive while scrolled up (iOS); at the bottom it follows.
        maintainVisibleContentPosition={{ minIndexForVisible: 1, autoscrollToTopThreshold: 48 }}
        initialNumToRender={12}
        maxToRenderPerBatch={8}
        windowSize={9}
      />
      {!follow.following ? (
        <Pressable accessibilityRole="button" accessibilityLabel={jumpLabel(follow.unseen)} onPress={jump} style={styles.jump}>
          <Text style={styles.jumpText}>↓ {jumpLabel(follow.unseen)}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  shell: { flex: 1 },
  transcript: { flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: mobileScale(12), paddingTop: mobileScale(8), paddingBottom: mobileScale(14) },
  messageGroup: { gap: mobileScale(8), marginBottom: mobileScale(12) },
  message: {
    maxWidth: '88%',
    paddingHorizontal: mobileScale(12),
    paddingTop: mobileScale(9),
    paddingBottom: mobileScale(11),
    borderWidth: 1,
    borderRadius: mobileScale(7),
  },
  messageUser: { alignSelf: 'flex-end', borderColor: theme.accentMuted, backgroundColor: theme.userMessage },
  messageAssistant: { alignSelf: 'flex-start', borderColor: theme.border, backgroundColor: theme.assistantMessage },
  messageHeader: { marginBottom: mobileScale(7), flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: mobileScale(18) },
  messageAuthor: { color: theme.textDim, fontSize: mobileScale(10), fontWeight: '700', letterSpacing: 0.8 },
  messageTime: { color: theme.textDim, fontSize: mobileScale(10), fontVariant: ['tabular-nums'] },
  messageText: { color: theme.text, fontSize: mobileScale(13), lineHeight: mobileScale(19) },
  notice: { alignSelf: 'center', maxWidth: '90%', marginBottom: mobileScale(12), paddingHorizontal: mobileScale(10), paddingVertical: mobileScale(4), borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: theme.border, backgroundColor: theme.surface },
  noticeText: { color: theme.textDim, fontSize: mobileScale(11), textAlign: 'center' },
  jump: {
    position: 'absolute',
    alignSelf: 'center',
    bottom: mobileScale(10),
    paddingHorizontal: mobileScale(14),
    paddingVertical: mobileScale(8),
    borderRadius: 999,
    backgroundColor: theme.surfaceRaised,
    borderWidth: 1,
    borderColor: theme.borderStrong,
  },
  jumpText: { color: theme.text, fontSize: mobileScale(12.5), fontWeight: '700' },
}));
