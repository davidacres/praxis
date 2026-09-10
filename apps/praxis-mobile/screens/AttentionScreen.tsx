import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Body, Button, Card, H1, Pill, Screen } from '../app/ui';
import { useStore, useOpenAttention } from '../app/store';

export function AttentionScreen(): React.JSX.Element {
  const items = useOpenAttention();
  const { approve, setRoute, openWork } = useStore();

  return (
    <Screen>
      <H1>Attention</H1>
      {items.length === 0 && (
        <Card>
          <Body dim>Nothing needs you right now.</Body>
        </Card>
      )}
      {items.map(item => (
        <Card key={item.id}>
          <View style={styles.row}>
            <Pill label={item.kind} tone={item.kind === 'failure' ? 'danger' : 'warn'} />
            <Body dim>{item.runId ?? item.sessionId}</Body>
          </View>
          <Body>
            {item.kind === 'approval'
              ? 'A run is waiting for your approval.'
              : item.kind === 'permission'
                ? 'The agent is asking permission to act.'
                : 'A stage failed and can be retried.'}
          </Body>
          {item.kind === 'approval' && item.runId && (
            <View style={styles.actions}>
              <Button
                label="Open run"
                kind="ghost"
                onPress={() => {
                  setRoute('work');
                  openWork('FX-BE-081');
                }}
              />
              <Button label="Approve" onPress={() => approve(item.runId!)} />
            </View>
          )}
        </Card>
      ))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  actions: { flexDirection: 'row', gap: 8 },
});
