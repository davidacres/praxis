import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Body, Button, Card, H1, Pill, Screen } from '../app/ui';
import { theme } from '../app/theme';
import { useStore } from '../app/store';
import type { MobileDetailTab } from '../renderer/mobileNavigation';
import { DEMO_RUN } from '../app/demoData';

const DETAIL_TABS: MobileDetailTab[] = ['chat', 'progress', 'changes'];

export function WorkScreen(): React.JSX.Element {
  const { work, openWorkId, openWork } = useStore();
  const open = work.find(item => item.workId === openWorkId);
  return open ? <WorkDetail workId={open.workId} onBack={() => openWork(undefined)} /> : <WorkList />;
}

function WorkList(): React.JSX.Element {
  const { work, openWork } = useStore();
  return (
    <Screen>
      <H1>Work</H1>
      {work.map(item => (
        <Pressable key={item.workId} onPress={() => openWork(item.workId)}>
          <Card>
            <View style={styles.rowBetween}>
              <Body dim>{item.workId}</Body>
              <Pill label={item.status} tone={item.status === 'Done' || item.status === 'Approved' ? 'ok' : 'neutral'} />
            </View>
            <Body>{item.title}</Body>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}

function WorkDetail({ workId, onBack }: { workId: string; onBack: () => void }): React.JSX.Element {
  const { work, shell, setDetail, transcriptFor, followUps, sendFollowUp, approve } = useStore();
  const item = work.find(entry => entry.workId === workId)!;
  const detail = shell.navigation.detail;
  const [draft, setDraft] = useState('');

  return (
    <Screen>
      <Pressable onPress={onBack}>
        <Body dim>‹ Work</Body>
      </Pressable>
      <H1>{item.workId}</H1>
      <Body>{item.title}</Body>

      <View style={styles.tabs}>
        {DETAIL_TABS.map(tab => (
          <Pressable key={tab} onPress={() => setDetail(tab)} style={[styles.tab, detail === tab && styles.tabActive]}>
            <Text style={[styles.tabText, detail === tab && styles.tabTextActive]}>{tab}</Text>
          </Pressable>
        ))}
      </View>

      {detail === 'chat' && (
        <>
          {transcriptFor(item.sessionId).map((line, index) => (
            <Card key={index}>
              <Body>{line}</Body>
            </Card>
          ))}
          {followUps
            .filter(message => message.workId === workId)
            .map(message => (
              <Card key={message.messageId} style={{ borderColor: theme.accent }}>
                <Body>{message.text}</Body>
                <Body dim>{message.state === 'completed' ? (message.result ?? 'done') : 'sending…'}</Body>
              </Card>
            ))}
          <View style={styles.composer}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Send a follow-up…"
              placeholderTextColor={theme.textDim}
              style={styles.input}
            />
            <Button
              label="Send"
              onPress={() => {
                if (draft.trim()) {
                  sendFollowUp(item, draft.trim());
                  setDraft('');
                }
              }}
            />
          </View>
        </>
      )}

      {detail === 'progress' && (
        <Card>
          <Body dim>{DEMO_RUN.workflowName} · {DEMO_RUN.status}</Body>
          {DEMO_RUN.stages.map(stage => (
            <View key={stage.nodeId} style={styles.rowBetween}>
              <Body>{stage.name}</Body>
              <Pill
                label={stage.outcome}
                tone={stage.outcome === 'succeeded' ? 'ok' : stage.outcome === 'awaiting' ? 'warn' : 'neutral'}
              />
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
    </Screen>
  );
}

const styles = StyleSheet.create({
  rowBetween: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tabs: { flexDirection: 'row', gap: 8 },
  tab: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, borderWidth: 1, borderColor: theme.border },
  tabActive: { backgroundColor: theme.surfaceRaised, borderColor: theme.accent },
  tabText: { color: theme.textDim, fontSize: 13, textTransform: 'capitalize' },
  tabTextActive: { color: theme.text },
  composer: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  input: {
    flex: 1,
    color: theme.text,
    backgroundColor: theme.surface,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});
