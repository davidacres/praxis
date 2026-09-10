import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { theme } from './theme';

export function Screen({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>{children}</ScrollView>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }): React.JSX.Element {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function H1({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Text style={styles.h1}>{children}</Text>;
}

export function Body({ children, dim }: { children: React.ReactNode; dim?: boolean }): React.JSX.Element {
  return <Text style={[styles.body, dim && styles.bodyDim]}>{children}</Text>;
}

export function Pill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'ok' | 'warn' | 'danger' }): React.JSX.Element {
  const color = tone === 'ok' ? theme.ok : tone === 'warn' ? theme.warn : tone === 'danger' ? theme.danger : theme.textDim;
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <Text style={[styles.pillText, { color }]}>{label}</Text>
    </View>
  );
}

export function Button({
  label,
  onPress,
  kind = 'primary',
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'ghost';
}): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'ghost' ? styles.buttonGhost : styles.buttonPrimary,
        pressed && styles.buttonPressed,
      ]}
    >
      <Text style={[styles.buttonText, kind === 'ghost' && styles.buttonTextGhost]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  screenContent: { padding: theme.space, gap: theme.space },
  card: { backgroundColor: theme.surface, borderRadius: theme.radius, borderWidth: 1, borderColor: theme.border, padding: theme.space, gap: 8 },
  h1: { color: theme.text, fontSize: 22, fontWeight: '700' },
  body: { color: theme.text, fontSize: 15, lineHeight: 21 },
  bodyDim: { color: theme.textDim },
  pill: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3 },
  pillText: { fontSize: 12, fontWeight: '600' },
  button: { borderRadius: 10, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center' },
  buttonPrimary: { backgroundColor: theme.accent },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.border },
  buttonPressed: { opacity: 0.7 },
  buttonText: { color: '#0b1220', fontSize: 15, fontWeight: '700' },
  buttonTextGhost: { color: theme.text },
});
