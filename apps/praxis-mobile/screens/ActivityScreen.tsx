import React from 'react';
import { View, StyleSheet } from 'react-native';
import { AppHeader, Body, Card, Screen } from '../app/ui';
import { theme } from '../app/theme';
import { DEMO_ACTIVITY } from '../app/demoData';

export function ActivityScreen({ onOpenSidebar }: { onOpenSidebar: () => void }): React.JSX.Element {
  return (
    <>
      <AppHeader title="Activity" onOpenSidebar={onOpenSidebar} />
      <Screen>
      {DEMO_ACTIVITY.map((entry, index) => (
        <Card key={index}>
          <View style={styles.row}>
            <Body dim>{entry.at}</Body>
            <View style={styles.dot} />
            <Body>{entry.text}</Body>
          </View>
        </Card>
      ))}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.accent },
});
