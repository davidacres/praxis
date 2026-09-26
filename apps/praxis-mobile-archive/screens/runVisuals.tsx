import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { mobileScale, theme, themedStyles } from '../app/theme';
import type { RunTone } from '../renderer/mobileWorkflowRuns';

/** Status colours shared by the run view, its steps sheet and the sidebar. */
export function toneColor(tone: RunTone): string {
  return tone === 'ok' ? theme.ok : tone === 'warn' ? theme.warn : tone === 'danger' ? theme.danger : tone === 'live' ? theme.accent : theme.textDim;
}

export function toneBackground(tone: RunTone): object {
  return { backgroundColor: tone === 'neutral' ? theme.surfaceRaised : toneColor(tone) };
}

/** `trailing` pushes the pill to the end of its row (the details strip); inline it sits where it is. */
export function StatusPill({ label, tone, trailing = true }: { label: string; tone: RunTone; trailing?: boolean }): React.JSX.Element {
  return (
    <View style={[styles.pill, trailing && styles.trailing, { borderColor: toneColor(tone) }]}>
      <Text numberOfLines={1} style={[styles.pillText, { color: toneColor(tone) }]}>{label}</Text>
    </View>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  trailing: { marginLeft: 'auto' },
  pill: { paddingHorizontal: mobileScale(8), paddingVertical: mobileScale(2), borderWidth: 1, borderRadius: 999 },
  pillText: { fontSize: mobileScale(10), fontWeight: '700' },
}));
