import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppHeader, Body, Card, Screen } from '../app/ui';
import { theme, themedStyles } from '../app/theme';
import { useStore } from '../app/store';

/** The latest turn of each session on the desktop, newest first — from live session snapshots. */
export function ActivityScreen({ onOpenSidebar }: { onOpenSidebar: () => void }): React.JSX.Element {
  const { activity, setRoute, openWork } = useStore();
  return (
    <>
      <AppHeader title="Activity" onOpenSidebar={onOpenSidebar} />
      <Screen>
        {activity.length === 0 ? (
          <Card>
            <Body dim>No session activity in this project yet. Sessions started here or on the desktop appear as they run.</Body>
          </Card>
        ) : null}
        {activity.map(entry => (
          <Pressable
            key={entry.id}
            accessibilityRole="button"
            accessibilityHint="Opens the session"
            onPress={() => {
              setRoute('work');
              openWork(entry.workId);
            }}
          >
            <Card>
              <View style={styles.row}>
                <Text style={styles.time}>{entry.at}</Text>
                <View style={styles.dot} />
                <Text numberOfLines={1} style={styles.title}>{entry.title}</Text>
              </View>
              <Body dim>{entry.text}</Body>
            </Card>
          </Pressable>
        ))}
      </Screen>
    </>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  time: { color: theme.textDim, fontSize: 12, fontVariant: ['tabular-nums'] },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.accent },
  title: { flex: 1, color: theme.text, fontSize: 14, fontWeight: '700' },
}));
