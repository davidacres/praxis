import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from './theme';
import { useStore, type MobilePrimaryRoute } from './store';

type SettingsPage = 'app' | 'server' | 'permissions';

interface AppSidebarProps {
  visible: boolean;
  onClose: () => void;
}

const ROUTES: Array<{ id: MobilePrimaryRoute; icon: string; label: string }> = [
  { id: 'attention', icon: '!', label: 'Attention' },
  { id: 'activity', icon: '⌁', label: 'Activity' },
];

const SETTINGS: Array<{ id: SettingsPage; icon: string; label: string; caption: string }> = [
  { id: 'app', icon: '⚙', label: 'App settings', caption: 'Appearance and notifications' },
  { id: 'server', icon: '⌁', label: 'Remote server', caption: 'Connection and host details' },
  { id: 'permissions', icon: '◇', label: 'Permissions', caption: 'Remote action access' },
];

function SectionLabel({ children }: { children: string }): React.JSX.Element {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

function NavRow({
  icon,
  label,
  caption,
  active,
  badge,
  onPress,
}: {
  icon: string;
  label: string;
  caption?: string;
  active?: boolean;
  badge?: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={({ pressed }) => [styles.navRow, active && styles.navRowActive, pressed && styles.navRowPressed]}
    >
      <View style={[styles.navIcon, active && styles.navIconActive]}>
        <Text style={[styles.navIconText, active && styles.navIconTextActive]}>{icon}</Text>
      </View>
      <View style={styles.navText}>
        <Text numberOfLines={1} style={[styles.navLabel, active && styles.navLabelActive]}>{label}</Text>
        {caption ? <Text numberOfLines={1} style={styles.navCaption}>{caption}</Text> : null}
      </View>
      {badge ? <Text style={styles.navBadge}>{badge}</Text> : null}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

function DetailRow({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'danger' }): React.JSX.Element {
  const valueColor = tone === 'ok' ? theme.ok : tone === 'warn' ? theme.warn : tone === 'danger' ? theme.danger : theme.textSecondary;
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, { color: valueColor }]}>{value}</Text>
    </View>
  );
}

function SettingsDetail({ page, onBack }: { page: SettingsPage; onBack: () => void }): React.JSX.Element {
  const { host, shell } = useStore();
  const title = SETTINGS.find(item => item.id === page)?.label ?? 'Settings';
  return (
    <View style={styles.detailPage}>
      <View style={styles.detailHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to navigation" onPress={onBack} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.detailTitle}>{title}</Text>
      </View>
      <ScrollView contentContainerStyle={styles.detailContent}>
        {page === 'app' && (
          <>
            <SectionLabel>APPEARANCE</SectionLabel>
            <View style={styles.detailCard}>
              <DetailRow label="Theme" value="Praxis dark" />
              <DetailRow label="Surface" value="Hexagon" />
              <DetailRow label="Follow desktop" value="On" tone="ok" />
            </View>
            <SectionLabel>NOTIFICATIONS</SectionLabel>
            <View style={styles.detailCard}>
              <DetailRow label="Attention requests" value="On" tone="ok" />
              <DetailRow label="Completed work" value="On" tone="ok" />
              <DetailRow label="Sounds and haptics" value="System" />
            </View>
          </>
        )}
        {page === 'server' && (
          <>
            <View style={styles.serverIdentity}>
              <View style={styles.serverGlyph}><Text style={styles.serverGlyphText}>P</Text></View>
              <View style={styles.serverIdentityText}>
                <Text style={styles.serverName}>{host.hostName}</Text>
                <Text style={styles.serverStatus}>●  Connected over local network</Text>
              </View>
            </View>
            <SectionLabel>CONNECTION</SectionLabel>
            <View style={styles.detailCard}>
              <DetailRow label="Host ID" value={host.hostId} />
              <DetailRow label="Transport" value="Noise IK" />
              <DetailRow label="Protocol" value="Praxis mobile v1" />
              <DetailRow label="State" value={shell.connection} tone="ok" />
            </View>
            <Text style={styles.detailNote}>Execution remains on this desktop host. The phone never receives provider credentials or repository access.</Text>
          </>
        )}
        {page === 'permissions' && (
          <>
            <Text style={styles.detailNote}>Permissions are enforced by the desktop host and scoped to the connected project.</Text>
            <SectionLabel>REMOTE ACCESS</SectionLabel>
            <View style={styles.detailCard}>
              <DetailRow label="View work" value="Allowed" tone="ok" />
              <DetailRow label="Continue sessions" value="Allowed" tone="ok" />
              <DetailRow label="Run workflows" value="Allowed" tone="ok" />
              <DetailRow label="Approvals" value="Ask every time" tone="warn" />
              <DetailRow label="Persistent allow" value="Unavailable" />
              <DetailRow label="Direct shell" value="Denied" tone="danger" />
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

export function AppSidebar({ visible, onClose }: AppSidebarProps): React.JSX.Element {
  const { shell, work, openWorkId, setRoute, openWork, startNewChat, attention, host } = useStore();
  const insets = useSafeAreaInsets();
  const [settingsPage, setSettingsPage] = useState<SettingsPage | undefined>();
  const unresolved = attention.filter(item => !item.resolved).length;

  useEffect(() => {
    if (!visible) setSettingsPage(undefined);
  }, [visible]);

  const navigate = (route: MobilePrimaryRoute): void => {
    setRoute(route);
    if (route !== 'work') openWork(undefined);
    onClose();
  };

  const openSession = (workId: string): void => {
    setRoute('work');
    openWork(workId);
    onClose();
  };

  return (
    <Modal animationType="fade" onRequestClose={onClose} transparent visible={visible}>
      <View style={styles.overlay}>
        <Pressable accessibilityLabel="Close navigation" accessibilityRole="button" onPress={onClose} style={styles.scrim} />
        <View style={[styles.drawer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          {settingsPage ? (
            <SettingsDetail page={settingsPage} onBack={() => setSettingsPage(undefined)} />
          ) : (
            <>
              <View style={styles.brand}>
                <View style={styles.brandMark}><Text style={styles.brandMarkText}>P</Text></View>
                <View style={styles.brandText}>
                  <Text style={styles.brandName}>Praxis</Text>
                  <Text style={styles.brandHost}>●  {host.hostName}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Close navigation" onPress={onClose} style={styles.closeButton}>
                  <Text style={styles.closeText}>×</Text>
                </Pressable>
              </View>

              <ScrollView contentContainerStyle={styles.drawerContent}>
                <SectionLabel>NAVIGATION</SectionLabel>
                {ROUTES.map(route => (
                  <NavRow
                    key={route.id}
                    icon={route.icon}
                    label={route.label}
                    active={shell.navigation.primary === route.id && !openWorkId}
                    badge={route.id === 'attention' && unresolved > 0 ? String(unresolved) : undefined}
                    onPress={() => navigate(route.id)}
                  />
                ))}

                <View style={styles.sectionHeading}>
                  <SectionLabel>SESSIONS</SectionLabel>
                  <View style={styles.sessionHeadingActions}>
                    <Text style={styles.sectionCount}>{work.length}</Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="New chat"
                      onPress={() => {
                        startNewChat();
                        onClose();
                      }}
                      style={({ pressed }) => [styles.newChatButton, pressed && styles.navRowPressed]}
                    >
                      <Text style={styles.newChatGlyph}>＋</Text>
                      <Text style={styles.newChatLabel}>New chat</Text>
                    </Pressable>
                  </View>
                </View>
                {work.map(item => {
                  const active = openWorkId === item.workId;
                  const live = item.status === 'In Progress';
                  return (
                    <NavRow
                      key={item.workId}
                      icon={live ? '●' : '✓'}
                      label={item.title}
                      caption={`${item.workId} · ${item.status}`}
                      active={active}
                      onPress={() => openSession(item.workId)}
                    />
                  );
                })}

                <SectionLabel>SETTINGS</SectionLabel>
                {SETTINGS.map(item => (
                  <NavRow key={item.id} icon={item.icon} label={item.label} caption={item.caption} onPress={() => setSettingsPage(item.id)} />
                ))}
              </ScrollView>
              <View style={styles.footer}>
                <Text style={styles.footerText}>Local connection · encrypted</Text>
                <Text style={styles.footerVersion}>v0.1</Text>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, flexDirection: 'row', backgroundColor: 'transparent' },
  scrim: { position: 'absolute', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.62)' },
  drawer: {
    width: '88%',
    maxWidth: 370,
    height: '100%',
    borderRightWidth: 1,
    borderRightColor: theme.borderStrong,
    backgroundColor: theme.bgSunken,
  },
  brand: {
    minHeight: 68,
    paddingHorizontal: 15,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  brandMark: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: theme.accentSoft, borderWidth: 1, borderColor: theme.accentMuted },
  brandMarkText: { color: theme.accent, fontSize: 18, fontWeight: '800' },
  brandText: { flex: 1 },
  brandName: { color: theme.text, fontSize: 17, fontWeight: '800' },
  brandHost: { marginTop: 2, color: theme.ok, fontSize: 10 },
  closeButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  closeText: { color: theme.textDim, fontSize: 22, fontWeight: '300' },
  drawerContent: { padding: 10, paddingBottom: 24 },
  sectionLabel: { marginTop: 14, marginBottom: 6, paddingHorizontal: 8, color: theme.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.9 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sessionHeadingActions: { marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 7 },
  sectionCount: { color: theme.textDim, fontSize: 10 },
  newChatButton: { height: 28, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: theme.border, borderRadius: 7, backgroundColor: theme.surface },
  newChatGlyph: { color: theme.accent, fontSize: 15, lineHeight: 17 },
  newChatLabel: { color: theme.textSecondary, fontSize: 10, fontWeight: '700' },
  navRow: { minHeight: 47, paddingHorizontal: 7, paddingVertical: 6, flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: 8 },
  navRowActive: { backgroundColor: theme.accentSoft },
  navRowPressed: { backgroundColor: theme.surfaceRaised },
  navIcon: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: theme.surface },
  navIconActive: { backgroundColor: theme.accentMuted },
  navIconText: { color: theme.textDim, fontSize: 13, fontWeight: '700' },
  navIconTextActive: { color: theme.text },
  navText: { flex: 1, minWidth: 0 },
  navLabel: { color: theme.textSecondary, fontSize: 13, fontWeight: '600' },
  navLabelActive: { color: theme.text },
  navCaption: { marginTop: 2, color: theme.textDim, fontSize: 10 },
  navBadge: { minWidth: 20, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden', borderRadius: 10, backgroundColor: theme.warn, color: theme.bgSunken, fontSize: 10, fontWeight: '800', textAlign: 'center' },
  chevron: { color: theme.textDim, fontSize: 18 },
  footer: { paddingHorizontal: 18, paddingVertical: 12, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: theme.border },
  footerText: { color: theme.textDim, fontSize: 10 },
  footerVersion: { color: theme.textDim, fontSize: 10 },
  detailPage: { flex: 1 },
  detailHeader: { minHeight: 60, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: theme.border },
  backButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: theme.surface },
  backText: { marginTop: -2, color: theme.textSecondary, fontSize: 27, lineHeight: 28 },
  detailTitle: { color: theme.text, fontSize: 16, fontWeight: '700' },
  detailContent: { padding: 12, paddingBottom: 30 },
  detailCard: { overflow: 'hidden', borderWidth: 1, borderColor: theme.border, borderRadius: 9, backgroundColor: theme.surface },
  detailRow: { minHeight: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  detailLabel: { color: theme.textSecondary, fontSize: 12 },
  detailValue: { flexShrink: 1, textAlign: 'right', fontSize: 12, fontWeight: '600' },
  detailNote: { marginVertical: 12, paddingHorizontal: 4, color: theme.textDim, fontSize: 11, lineHeight: 17 },
  serverIdentity: { marginBottom: 4, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 11, borderWidth: 1, borderColor: theme.border, borderRadius: 9, backgroundColor: theme.surface },
  serverGlyph: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: theme.accentSoft },
  serverGlyphText: { color: theme.accent, fontSize: 19, fontWeight: '800' },
  serverIdentityText: { flex: 1 },
  serverName: { color: theme.text, fontSize: 14, fontWeight: '700' },
  serverStatus: { marginTop: 4, color: theme.ok, fontSize: 10 },
});
