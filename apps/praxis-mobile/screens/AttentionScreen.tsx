import React from 'react';
import { View, StyleSheet } from 'react-native';
import { AppHeader, Body, Button, Card, Pill, Screen } from '../app/ui';
import { useStore, useOpenAttention } from '../app/store';
import { attentionSubject } from '../renderer/mobileAttention';

export function AttentionScreen({ onOpenSidebar }: { onOpenSidebar: () => void }): React.JSX.Element {
  const items = useOpenAttention();
  const { approve, respondToPermission, setRoute, openWork, work, runs } = useStore();
  const [failure, setFailure] = React.useState<string | undefined>(undefined);
  const act = (action: Promise<void>): void => {
    setFailure(undefined);
    void action.catch(error => setFailure(error instanceof Error ? error.message : String(error)));
  };

  return (
    <>
      <AppHeader title="Attention" onOpenSidebar={onOpenSidebar} />
      <Screen>
      {failure ? <Card><Body>{failure}</Body></Card> : null}
      {items.length === 0 && (
        <Card>
          <Body dim>Nothing needs you right now.</Body>
        </Card>
      )}
      {items.map(item => (
        <Card key={item.id}>
          <View style={styles.row}>
            <Pill label={item.kind} tone={item.kind === 'failure' ? 'danger' : 'warn'} />
            <Body dim>{attentionSubject(item, work, runs)}</Body>
          </View>
          <Body>
            {item.kind === 'approval'
              ? 'A run is waiting for your approval.'
              : item.kind === 'permission'
                ? (item.summary ?? 'The agent is asking permission to act.')
                : 'A stage failed and can be retried.'}
          </Body>
          {item.kind === 'permission' && item.detail ? <Body dim>{item.detail}</Body> : null}
          {item.kind === 'approval' && item.runId && (
            <View style={styles.actions}>
              {work.some(entry => entry.runId === item.runId) ? (
                <Button
                  label="Open run"
                  kind="ghost"
                  onPress={() => {
                    setRoute('work');
                    openWork(work.find(entry => entry.runId === item.runId)!.workId);
                  }}
                />
              ) : null}
              <Button label="Approve" onPress={() => act(approve(item.runId!))} />
            </View>
          )}
          {item.kind === 'permission' && item.requestId && (
            <View style={styles.actions}>
              <Button label="Deny" kind="ghost" onPress={() => act(respondToPermission(item.requestId!, 'deny'))} />
              <Button label="Allow once" onPress={() => act(respondToPermission(item.requestId!, 'allow'))} />
            </View>
          )}
        </Card>
      ))}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actions: { flexDirection: 'row', gap: 8 },
});
