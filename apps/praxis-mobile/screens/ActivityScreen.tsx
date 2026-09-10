import React from 'react';
import { View, StyleSheet } from 'react-native';
import { Body, Card, H1, Screen } from '../app/ui';
import { theme } from '../app/theme';
import { DEMO_ACTIVITY } from '../app/demoData';

export function ActivityScreen(): React.JSX.Element {
  return (
    <Screen>
      <H1>Activity</H1>
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
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.accent },
});
