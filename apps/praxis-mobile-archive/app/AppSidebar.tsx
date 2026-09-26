import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { applyDisplayMode, currentAppearance, currentDisplayMode, mobileScale, theme, themedStyles, type MobileDisplayMode } from './theme';
import { saveMobileDisplayMode } from './mobileConnection';
import { useStore, type MobilePrimaryRoute } from './store';
import { formatDayAndClock } from '../renderer/mobileTime';
import { PraxisWordmark } from './PraxisWordmark';
import { clearDiagnostics, useDiagnostics } from './diagnostics';
import { isStageSessionKey, runCaption, runStageSessionKeys, runStatus } from '../renderer/mobileWorkflowRuns';

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
  { id: 'server', icon: '⌁', label: 'Desktop connection', caption: 'Connection and host details' },
  { id: 'permissions', icon: '◇', label: 'Permissions', caption: 'What the desktop allows this phone' },
  { id: 'app', icon: '⚙', label: 'App settings', caption: 'Appearance and notifications' },
];

const CONNECTION_TEXT: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' }> = {
  ready: { label: 'Connected', tone: 'ok' },
  reconnecting: { label: 'Reconnecting', tone: 'warn' },
  connecting: { label: 'Connecting', tone: 'warn' },
  pairing: { label: 'Awaiting confirmation', tone: 'warn' },
  offline: { label: 'Offline', tone: 'danger' },
};

const CAPABILITY_ROWS: Array<{ capability: 'view' | 'execute' | 'approve'; label: string }> = [
  { capability: 'view', label: 'View sessions, runs and attention' },
  { capability: 'execute', label: 'Start and continue sessions, run workflows' },
  { capability: 'approve', label: 'Approve gates and answer permission requests' },
];

const formatWhen = (at: string | undefined): string | undefined => formatDayAndClock(at);

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

/** What went wrong talking to the desktop recently, so a failure is findable rather than silent. */
function DiagnosticsSection(): React.JSX.Element {
  const entries = useDiagnostics();
  return (
    <>
      <SectionLabel>DIAGNOSTICS</SectionLabel>
      <View style={styles.detailCard}>
        {entries.length === 0 ? <DetailRow label="Recent problems" value="None" tone="ok" /> : null}
        {entries.slice(0, 12).map((entry, index) => (
          <View key={`${entry.at}:${index}`} style={styles.detailRow}>
            <Text style={styles.detailLabel}>{formatDayAndClock(entry.at)} · {entry.what}</Text>
            <Text selectable style={[styles.detailValue, { color: theme.warn }]}>{entry.message}</Text>
          </View>
        ))}
      </View>
      {entries.length > 0 ? (
        <Pressable accessibilityRole="button" onPress={clearDiagnostics} style={({ pressed }) => [styles.displayMode, pressed && styles.navRowPressed]}>
          <Text style={styles.displayModeTitle}>Clear</Text>
        </Pressable>
      ) : null}
      <Text style={styles.detailNote}>Background refreshes and screens that fail are listed here, newest first. Nothing is sent anywhere.</Text>
    </>
  );
}

function SettingsDetail({ page, onBack }: { page: SettingsPage; onBack: () => void }): React.JSX.Element {
  const { host, shell, hostInfo, hostConfig, access, connectionIssue, retryConnection, disconnect } = useStore();
  const title = SETTINGS.find(item => item.id === page)?.label ?? 'Settings';
  const state = CONNECTION_TEXT[shell.connection] ?? CONNECTION_TEXT.offline!;
  const grant = access.value;
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
              <DetailRow label="Theme" value={currentAppearance()?.themeName ?? 'Praxis Dark'} />
              <DetailRow label="Follows" value={currentAppearance() ? 'The desktop' : 'Default until paired'} />
            </View>
            <Text style={styles.detailNote}>The phone wears the paired desktop’s theme and changes with it. Choose a theme in the desktop’s Settings → Themes.</Text>
            <SectionLabel>DISPLAY SIZE</SectionLabel>
            <View style={styles.displayModes}>
              {(['compact', 'large'] as MobileDisplayMode[]).map(mode => {
                const selected = currentDisplayMode() === mode;
                return (
                  <Pressable
                    key={mode}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`${mode === 'large' ? 'Large' : 'Compact'} display size`}
                    onPress={() => { if (applyDisplayMode(mode)) void saveMobileDisplayMode(mode); }}
                    style={({ pressed }) => [styles.displayMode, selected && styles.displayModeSelected, pressed && styles.navRowPressed]}
                  >
                    <Text style={[styles.displayModeTitle, selected && styles.displayModeTitleSelected]}>{mode === 'large' ? 'Large' : 'Compact'}</Text>
                    <Text style={styles.displayModeCaption}>{mode === 'large' ? 'Larger text and controls' : 'Current sizing'}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.detailNote}>Large mode increases reading size, spacing and touch targets across the mobile app. Compact keeps the current density.</Text>
            <SectionLabel>NOTIFICATIONS</SectionLabel>
            <View style={styles.detailCard}>
              <DetailRow label="Push notifications" value="Not available" />
              <DetailRow label="Attention while open" value="Live from the desktop" />
            </View>
            <Text style={styles.detailNote}>Praxis mobile does not send notifications yet. Attention requests and session updates arrive live while the app is open and connected.</Text>
            <SectionLabel>SECURITY</SectionLabel>
            <View style={styles.detailCard}>
              <DetailRow label="Approvals and allowing agents" value="Face ID or passcode" />
            </View>
            <Text style={styles.detailNote}>Approving a run, rejecting one, allowing an agent to act, or answering a question that changes something asks you to confirm it is you. One check covers a minute of decisions.</Text>
            <DiagnosticsSection />
          </>
        )}
        {page === 'server' && (
          <>
            <View style={styles.serverIdentity}>
              <View style={styles.serverGlyph}><Text style={styles.serverGlyphText}>P</Text></View>
              <View style={styles.serverIdentityText}>
                <Text style={styles.serverName}>{host.hostName || hostConfig?.hostName || hostConfig?.address || 'Desktop'}</Text>
                <Text style={[styles.serverStatus, { color: toneColor(state.tone) }]}>●  {state.label}{shell.connection === 'ready' ? ' over the local network' : ''}</Text>
              </View>
            </View>
            {connectionIssue && shell.connection !== 'ready' ? <Text style={[styles.detailNote, { color: theme.warn }]}>{connectionIssue.message}</Text> : null}
            <SectionLabel>CONNECTION</SectionLabel>
            <View style={styles.detailCard}>
              <DetailRow label="State" value={state.label} tone={state.tone} />
              {hostConfig ? <DetailRow label="Address" value={`${hostConfig.address}:${hostConfig.port}`} /> : null}
              <DetailRow label="Host ID" value={host.hostId || hostConfig?.hostId || '—'} />
              {grant?.hostKeyFingerprint ? <DetailRow label="Host key" value={grant.hostKeyFingerprint} /> : null}
              <DetailRow label="Transport" value="Noise IK, encrypted" />
              <DetailRow label="Protocol" value={hostInfo ? `v${hostInfo.protocolVersion} · revision ${hostInfo.surfaceRevision}` : 'v1 · revision 1 (older desktop)'} />
              {grant ? <DetailRow label="Desktop access mode" value={grant.accessMode === 'local-only' ? 'Local network only' : grant.accessMode === 'internet' ? 'Internet relay' : 'Off'} tone={grant.accessMode === 'off' ? 'danger' : undefined} /> : null}
            </View>
            <View style={styles.detailActions}>
              {shell.connection !== 'ready' ? (
                <Pressable accessibilityRole="button" onPress={retryConnection} style={({ pressed }) => [styles.detailButton, pressed && styles.navRowPressed]}>
                  <Text style={styles.detailButtonText}>Reconnect now</Text>
                </Pressable>
              ) : null}
              <Pressable accessibilityRole="button" onPress={() => disconnect()} style={({ pressed }) => [styles.detailButton, pressed && styles.navRowPressed]}>
                <Text style={styles.detailButtonText}>Disconnect</Text>
              </Pressable>
            </View>
            <Text style={styles.detailNote}>Execution stays on this desktop. The phone never receives provider credentials, repository paths or the desktop’s private key.</Text>
          </>
        )}
        {page === 'permissions' && (
          <>
            <Text style={styles.detailNote}>Granted when this phone was confirmed on the desktop and enforced there on every request. Change it in Settings → Mobile access on the desktop.</Text>
            {access.status === 'loading' || access.status === 'idle' ? <Text style={styles.detailNote}>Loading this phone’s grant from the desktop…</Text> : null}
            {access.status === 'unsupported' || access.status === 'error' ? <Text style={[styles.detailNote, { color: theme.warn }]}>{access.message}</Text> : null}
            {grant ? (
              <>
                <SectionLabel>THIS PHONE</SectionLabel>
                <View style={styles.detailCard}>
                  <DetailRow label="Name on desktop" value={grant.label ?? grant.deviceId} />
                  {formatWhen(grant.pairedAt) ? <DetailRow label="Paired" value={formatWhen(grant.pairedAt)!} /> : null}
                  {formatWhen(grant.lastSeenAt) ? <DetailRow label="Last connected" value={formatWhen(grant.lastSeenAt)!} /> : null}
                </View>
                <SectionLabel>REMOTE ACTIONS</SectionLabel>
                <View style={styles.detailCard}>
                  {CAPABILITY_ROWS.map(row => {
                    const allowed = grant.capabilities.includes(row.capability);
                    return <DetailRow key={row.capability} label={row.label} value={allowed ? 'Allowed' : 'Not allowed'} tone={allowed ? 'ok' : 'danger'} />;
                  })}
                  <DetailRow label="Shell or file access" value="Never offered to phones" />
                </View>
                <SectionLabel>PROJECTS</SectionLabel>
                <View style={styles.detailCard}>
                  {grant.projects.length === 0 ? <DetailRow label="Scope" value="All projects" /> : grant.projects.map(item => <DetailRow key={item.projectId} label={item.name} value="Granted" tone="ok" />)}
                </View>
                <Text style={styles.detailNote}>Each tool permission an agent asks for is answered once, here or on the desktop; the phone cannot grant standing permissions.</Text>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function toneColor(tone: 'ok' | 'warn' | 'danger'): string {
  return tone === 'ok' ? theme.ok : tone === 'warn' ? theme.warn : theme.danger;
}

export function AppSidebar({ visible, onClose }: AppSidebarProps): React.JSX.Element {
  const { shell, work, openWorkId, openRunId, workflowRuns, runsSupported, openRun, setRoute, setDetail, openWork, startNewChat, attention, hostInfo } = useStore();
  // A run's stage sessions are reached through the run, as on the desktop — not as loose chats.
  const stageKeys = runStageSessionKeys(workflowRuns);
  const chats = work.filter(item => item.draft || (!stageKeys.has(item.workId) && !isStageSessionKey(item.workId, item.runId)));
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

  const showRun = (runId: string): void => {
    openRun(runId);
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
                <PraxisWordmark width={102} height={32} />
                <Pressable accessibilityRole="button" accessibilityLabel="Close navigation" onPress={onClose} style={[styles.closeButton, styles.closeButtonRight]}>
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
                    active={shell.navigation.primary === route.id && !openWorkId && !openRunId}
                    badge={route.id === 'attention' && unresolved > 0 ? String(unresolved) : undefined}
                    onPress={() => navigate(route.id)}
                  />
                ))}

                {runsSupported ? (
                  <>
                    <View style={styles.sectionHeading}>
                      <SectionLabel>WORKFLOW RUNS</SectionLabel>
                      <Text style={[styles.sectionCount, styles.sectionCountSpaced]}>{workflowRuns.length}</Text>
                    </View>
                    {workflowRuns.length === 0 ? (
                      <Text style={styles.emptyNote}>No workflow runs in this project yet. Start one from a chat’s workflow menu or on the desktop.</Text>
                    ) : workflowRuns.map(run => {
                      const status = runStatus(run);
                      return (
                        <NavRow
                          key={run.runId}
                          icon={status.icon}
                          label={run.workflowName}
                          caption={runCaption(run)}
                          active={openRunId === run.runId}
                          onPress={() => showRun(run.runId)}
                        />
                      );
                    })}
                  </>
                ) : null}

                <View style={styles.sectionHeading}>
                  <SectionLabel>SESSIONS</SectionLabel>
                  <View style={styles.sessionHeadingActions}>
                    <Text style={styles.sectionCount}>{chats.length}</Text>
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
                {chats.map(item => {
                  const active = openWorkId === item.workId;
                  const live = item.status === 'active' || item.status === 'awaiting-input';
                  return (
                    <NavRow
                      key={item.workId}
                      icon={item.draft ? '＋' : live ? '●' : '✓'}
                      label={item.title}
                      caption={item.draft ? 'Draft · not sent yet' : `${item.mode === 'chat' ? '' : `${item.mode[0]!.toUpperCase()}${item.mode.slice(1)} · `}${item.status}${item.model ? ` · ${item.model}` : ''}`}
                      active={active}
                      onPress={() => openSession(item.workId)}
                    />
                  );
                })}

                {openWorkId ? (
                  <>
                    <SectionLabel>SESSION VIEWS</SectionLabel>
                    {(['chat', 'progress', 'changes'] as const).map(detail => (
                      <NavRow
                        key={detail}
                        icon={detail === 'chat' ? '☷' : detail === 'progress' ? '◔' : '⌁'}
                        label={detail[0]!.toUpperCase() + detail.slice(1)}
                        active={shell.navigation.detail === detail}
                        onPress={() => {
                          setRoute('work');
                          setDetail(detail);
                          onClose();
                        }}
                      />
                    ))}
                  </>
                ) : null}

                <SectionLabel>SETTINGS</SectionLabel>
                {SETTINGS.map(item => (
                  <NavRow key={item.id} icon={item.icon} label={item.label} caption={item.caption} onPress={() => setSettingsPage(item.id)} />
                ))}
              </ScrollView>
              <View style={styles.footer}>
                <Text style={styles.footerText}>Local connection · Noise IK encrypted</Text>
                <Text style={styles.footerVersion}>{hostInfo ? `rev ${hostInfo.surfaceRevision}` : 'rev 1'}</Text>
              </View>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = themedStyles(() => StyleSheet.create({
  overlay: { flex: 1, flexDirection: 'row', backgroundColor: 'transparent' },
  scrim: { position: 'absolute', inset: 0, backgroundColor: theme.scrim },
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
    gap: 8,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  closeButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  closeButtonRight: { marginLeft: 'auto' },
  closeText: { color: theme.textDim, fontSize: 22, fontWeight: '300' },
  drawerContent: { padding: 10, paddingBottom: 24 },
  sectionLabel: { marginTop: mobileScale(14), marginBottom: mobileScale(6), paddingHorizontal: mobileScale(8), color: theme.textDim, fontSize: mobileScale(10), fontWeight: '700', letterSpacing: 0.9 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sessionHeadingActions: { marginTop: 8, flexDirection: 'row', alignItems: 'center', gap: 7 },
  sectionCount: { color: theme.textDim, fontSize: 10 },
  sectionCountSpaced: { marginTop: 8, marginRight: 8 },
  emptyNote: { paddingHorizontal: mobileScale(8), paddingBottom: mobileScale(6), color: theme.textDim, fontSize: mobileScale(11), lineHeight: mobileScale(16) },
  newChatButton: { height: 28, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: theme.border, borderRadius: 7, backgroundColor: theme.surface },
  newChatGlyph: { color: theme.accent, fontSize: 15, lineHeight: 17 },
  newChatLabel: { color: theme.textSecondary, fontSize: 10, fontWeight: '700' },
  navRow: { minHeight: mobileScale(47), paddingHorizontal: mobileScale(7), paddingVertical: mobileScale(6), flexDirection: 'row', alignItems: 'center', gap: mobileScale(9), borderRadius: mobileScale(8) },
  navRowActive: { backgroundColor: theme.accentSoft },
  navRowPressed: { backgroundColor: theme.surfaceRaised },
  navIcon: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: theme.surface },
  navIconActive: { backgroundColor: theme.accentMuted },
  navIconText: { color: theme.textDim, fontSize: 13, fontWeight: '700' },
  navIconTextActive: { color: theme.text },
  navText: { flex: 1, minWidth: 0 },
  navLabel: { color: theme.textSecondary, fontSize: mobileScale(13), fontWeight: '600' },
  navLabelActive: { color: theme.text },
  navCaption: { marginTop: mobileScale(2), color: theme.textDim, fontSize: mobileScale(10) },
  navBadge: { minWidth: 20, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden', borderRadius: 10, backgroundColor: theme.warn, color: theme.bgSunken, fontSize: 10, fontWeight: '800', textAlign: 'center' },
  chevron: { color: theme.textDim, fontSize: 18 },
  footer: { paddingHorizontal: 18, paddingVertical: 12, flexDirection: 'row', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: theme.border },
  footerText: { color: theme.textDim, fontSize: 10 },
  footerVersion: { color: theme.textDim, fontSize: 10 },
  detailPage: { flex: 1 },
  detailHeader: { minHeight: 60, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: theme.border },
  backButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: theme.surface },
  backText: { marginTop: -2, color: theme.textSecondary, fontSize: 27, lineHeight: 28 },
  detailTitle: { color: theme.text, fontSize: mobileScale(16), fontWeight: '700' },
  detailContent: { padding: 12, paddingBottom: 30 },
  detailCard: { overflow: 'hidden', borderWidth: 1, borderColor: theme.border, borderRadius: 9, backgroundColor: theme.surface },
  detailRow: { minHeight: 44, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border },
  // The label wraps before the value does, so a short value ("Allowed") never breaks a letter a line.
  detailLabel: { flex: 1, color: theme.textSecondary, fontSize: mobileScale(12) },
  detailValue: { flexShrink: 1, maxWidth: '60%', textAlign: 'right', fontSize: mobileScale(12), fontWeight: '600' },
  detailNote: { marginVertical: mobileScale(12), paddingHorizontal: mobileScale(4), color: theme.textDim, fontSize: mobileScale(11), lineHeight: mobileScale(17) },
  displayModes: { flexDirection: 'row', gap: 8 },
  displayMode: { flex: 1, minHeight: mobileScale(58), padding: mobileScale(10), borderWidth: 1, borderColor: theme.border, borderRadius: mobileScale(9), backgroundColor: theme.bgSunken },
  displayModeSelected: { borderColor: theme.accent, backgroundColor: theme.accentSoft },
  displayModeTitle: { color: theme.textSecondary, fontSize: mobileScale(13), fontWeight: '700' },
  displayModeTitleSelected: { color: theme.accent },
  displayModeCaption: { marginTop: mobileScale(4), color: theme.textDim, fontSize: mobileScale(10) },
  serverIdentity: { marginBottom: 4, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 11, borderWidth: 1, borderColor: theme.border, borderRadius: 9, backgroundColor: theme.surface },
  serverGlyph: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: theme.accentSoft },
  serverGlyphText: { color: theme.accent, fontSize: 19, fontWeight: '800' },
  serverIdentityText: { flex: 1 },
  serverName: { color: theme.text, fontSize: 14, fontWeight: '700' },
  serverStatus: { marginTop: 4, fontSize: 10 },
  detailActions: { marginTop: 12, flexDirection: 'row', gap: 8 },
  detailButton: { minHeight: 38, paddingHorizontal: 14, justifyContent: 'center', borderWidth: 1, borderColor: theme.border, borderRadius: 8, backgroundColor: theme.surface },
  detailButtonText: { color: theme.textSecondary, fontSize: 12, fontWeight: '700' },
}));
