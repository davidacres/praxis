import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { mobileScale, theme, themedStyles } from './theme';
import { useStore } from './store';
import { useSyncState } from './diagnostics';
import { describeStaleness } from '../renderer/mobileDiagnostics';
import { formatClock } from '../renderer/mobileTime';

export function Screen({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>{children}</ScrollView>;
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }): React.JSX.Element {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function H1({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <Text style={styles.h1}>{children}</Text>;
}

export function AppHeader({ title, onOpenSidebar }: { title: string; onOpenSidebar: () => void }): React.JSX.Element {
  return (
    <View style={styles.appHeader}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open navigation"
        hitSlop={8}
        onPress={onOpenSidebar}
        style={({ pressed }) => [styles.menuButton, pressed && styles.buttonPressed]}
      >
        <Text style={styles.menuGlyph}>☰</Text>
      </Pressable>
      <Text style={styles.appHeaderTitle}>{title}</Text>
      <ConnectionBadge />
    </View>
  );
}

/** The real connection state: live, reconnecting (with the reason on long-press), or offline. */
export function ConnectionBadge(): React.JSX.Element {
  const { shell, connectionIssue, retryConnection } = useStore();
  const state = shell.connection;
  const tone = state === 'ready' ? theme.ok : state === 'reconnecting' ? theme.warn : theme.danger;
  const label = state === 'ready' ? 'LIVE' : state === 'reconnecting' ? 'RECONNECTING' : 'OFFLINE';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={state === 'ready' ? 'Connected to the desktop' : `${label.toLowerCase()}${connectionIssue ? `: ${connectionIssue.message}` : ''}. Tap to retry now.`}
      disabled={state === 'ready'}
      hitSlop={8}
      onPress={retryConnection}
      style={styles.connectionState}
    >
      <View style={[styles.connectionDot, { backgroundColor: tone }]} />
      <Text style={styles.connectionText}>{label}</Text>
    </Pressable>
  );
}

/**
 * Shown while a background refresh is failing: what is on screen may be out of
 * date, and the person should know rather than act on it as if current.
 */
export function StaleBanner(): React.JSX.Element | null {
  const sync = useSyncState();
  const { shell, retryConnection } = useStore();
  const text = describeStaleness(sync, formatClock);
  if (!text || shell.connection !== 'ready') return null;
  return (
    <Pressable accessibilityRole="alert" accessibilityHint="Reconnects to the desktop" onPress={retryConnection} style={styles.stale}>
      <Text style={styles.staleText}>{text} Tap to reconnect.</Text>
    </Pressable>
  );
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
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'ghost';
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        kind === 'ghost' ? styles.buttonGhost : styles.buttonPrimary,
        pressed && styles.buttonPressed,
        disabled && styles.buttonDisabled,
      ]}
    >
      <Text style={[styles.buttonText, kind === 'ghost' && styles.buttonTextGhost]}>{label}</Text>
    </Pressable>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.bg },
  screenContent: { padding: theme.space, gap: theme.space },
  card: { backgroundColor: theme.surface, borderRadius: theme.radius, borderWidth: 1, borderColor: theme.border, padding: theme.space, gap: 8 },
  h1: { color: theme.text, fontSize: mobileScale(22), fontWeight: '700' },
  appHeader: {
    minHeight: mobileScale(52),
    paddingHorizontal: mobileScale(12),
    flexDirection: 'row',
    alignItems: 'center',
    gap: mobileScale(10),
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
    backgroundColor: theme.bgSunken,
  },
  menuButton: {
    width: mobileScale(32),
    height: mobileScale(32),
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: mobileScale(7),
    backgroundColor: theme.surface,
  },
  menuGlyph: { color: theme.textSecondary, fontSize: mobileScale(17), lineHeight: mobileScale(19) },
  appHeaderTitle: { flex: 1, color: theme.text, fontSize: mobileScale(15), fontWeight: '700' },
  connectionState: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  connectionDot: { width: 6, height: 6, borderRadius: 3 },
  connectionText: { color: theme.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.6 },
  stale: { paddingHorizontal: mobileScale(12), paddingVertical: mobileScale(8), backgroundColor: theme.warnSoft, borderBottomWidth: 1, borderBottomColor: theme.warn },
  staleText: { color: theme.text, fontSize: mobileScale(12.5), lineHeight: mobileScale(18) },
  body: { color: theme.text, fontSize: mobileScale(15), lineHeight: mobileScale(21) },
  bodyDim: { color: theme.textDim },
  pill: { alignSelf: 'flex-start', borderWidth: 1, borderRadius: 999, paddingHorizontal: mobileScale(10), paddingVertical: mobileScale(3) },
  pillText: { fontSize: mobileScale(12), fontWeight: '600' },
  button: { minHeight: mobileScale(46), borderRadius: mobileScale(10), paddingVertical: mobileScale(12), paddingHorizontal: mobileScale(16), alignItems: 'center', justifyContent: 'center' },
  buttonPrimary: { backgroundColor: theme.accent },
  buttonGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: theme.border },
  buttonPressed: { opacity: 0.7 },
  buttonDisabled: { opacity: 0.45 },
  buttonText: { color: theme.onAccent, fontSize: mobileScale(15), fontWeight: '700' },
  buttonTextGhost: { color: theme.text },
}));
