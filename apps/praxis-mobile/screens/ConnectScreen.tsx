import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Body, Button, Card, H1, Screen } from '../app/ui';
import { useStore } from '../app/store';
import { theme } from '../app/theme';
import { loadMobileHostConfiguration, type MobileHostConfiguration } from '../app/mobileConnection';
import { listenForMobileHosts, type DiscoveredMobileHost } from '../app/mobileDiscovery';
import { parseMobileInvitation, type MobileInvitationDetails } from '../renderer/mobilePairingInvitation';
import { formatClock, parseInstant } from '../renderer/mobileTime';

const ACTION_HINTS = {
  rescan: 'Open Settings → Mobile access on the desktop, create a pairing invitation, and scan it here.',
  retry: 'Check that Praxis is running on the desktop, Mobile access is on, and both devices are on the same network.',
  wait: 'Confirm this phone on the desktop.',
  'check-desktop': 'Check Settings → Mobile access on the desktop.',
} as const;

export function ConnectScreen(): React.JSX.Element {
  const { shell, connect, connectionIssue, pairing, cancelConnect, retryConnection, disconnect, hostConfig } = useStore();
  const connecting = shell.connection === 'connecting';
  const pairingPending = shell.connection === 'pairing';
  const [address, setAddress] = useState('');
  const [port, setPort] = useState('43100');
  const [hostId, setHostId] = useState('');
  const [hostName, setHostName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [invitationText, setInvitationText] = useState('');
  const [invitation, setInvitation] = useState<MobileInvitationDetails | undefined>(undefined);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [discovered, setDiscovered] = useState<DiscoveredMobileHost[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  const applySaved = (config: MobileHostConfiguration): void => {
    setAddress(config.address);
    setPort(String(config.port));
    setHostId(config.hostId);
    setHostName(config.hostName ?? '');
    setProjectId(config.projectId ?? '');
    setInvitation({ hostPublicKeyHex: config.hostPublicKeyHex });
    setInvitationText(config.hostPublicKeyHex);
  };

  useEffect(() => {
    let live = true;
    void loadMobileHostConfiguration().then(config => {
      if (!live || !config) return;
      applySaved(config);
      void connect(config);
    });
    return () => { live = false; };
  }, []);

  useEffect(() => listenForMobileHosts(host => {
    setDiscovered(previous => [host, ...previous.filter(item => item.hostId !== host.hostId)].slice(0, 5));
  }), []);

  const importConnectionDetails = (value: string): void => {
    setInvitationText(value);
    setFormError(undefined);
    const parsed = parseMobileInvitation(value);
    if (parsed.kind === 'unrecognised') {
      setInvitation(undefined);
      if (value.trim()) setFormError('That is not a Praxis pairing invitation or host key. Copy the invitation from Settings → Mobile access on the desktop.');
      return;
    }
    const details = parsed.details;
    setInvitation(details);
    // A project belongs to one desktop: an invitation from another drops the old one's.
    if (details.hostId && details.hostId !== hostId) setProjectId('');
    if (details.hostId) setHostId(details.hostId);
    if (details.hostName) setHostName(details.hostName);
    if (details.address) setAddress(details.address);
    if (details.port) setPort(String(details.port));
    if (parsed.kind === 'invitation' && parsed.expired) {
      setFormError(`This invitation expired at ${formatClock(details.expiresAt)}. Create a new one in Settings → Mobile access on the desktop.`);
    }
  };

  /** Forgets the paired desktop and everything the form remembered about it. */
  const forgetDesktop = (): void => {
    disconnect({ forget: true });
    setAddress('');
    setPort('43100');
    setHostId('');
    setHostName('');
    setProjectId('');
    setInvitation(undefined);
    setInvitationText('');
    setFormError(undefined);
  };

  const openScanner = async (): Promise<void> => {
    const permission = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    if (permission.granted) setScannerOpen(true);
  };

  const submit = (): void => {
    setFormError(undefined);
    const parsedPort = Number(port);
    if (!address.trim()) return setFormError('Enter the desktop’s address, or scan its pairing invitation.');
    if (!hostId.trim()) return setFormError('Enter the desktop’s host ID, or scan its pairing invitation.');
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return setFormError('The port must be a number from 1 to 65535.');
    if (!invitation?.hostPublicKeyHex) return setFormError('Scan or paste the desktop’s pairing invitation so this phone can pin its host key.');
    if (invitation.expiresAt && (parseInstant(invitation.expiresAt) ?? Infinity) <= Date.now()) {
      return setFormError('This invitation has expired. Create a new one in Settings → Mobile access on the desktop.');
    }
    void connect({
      address: address.trim(),
      port: parsedPort,
      hostId: hostId.trim(),
      ...(hostName.trim() ? { hostName: hostName.trim() } : {}),
      hostPublicKeyHex: invitation.hostPublicKeyHex,
      ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
      ...(invitation.tokenId ? { pairingTokenId: invitation.tokenId } : {}),
      ...(invitation.expiresAt ? { pairingExpiresAt: invitation.expiresAt } : {}),
    });
  };

  const desktopName = hostConfig?.hostName || hostName || address || 'the desktop';

  return (
    <Screen>
      <H1>Praxis</H1>
      <Card>
        <Body>Continue and act on work running on your desktop host.</Body>
        <Body dim>
          Pair once with a QR code from the desktop; after that the phone reconnects over an encrypted channel. Agents, keys and
          repositories stay on the desktop.
        </Body>
      </Card>

      {pairingPending ? (
        <Card style={styles.pendingCard}>
          <View style={styles.statusRow}>
            <ActivityIndicator color={theme.warn} />
            <Text style={styles.statusTitle}>Waiting for confirmation</Text>
          </View>
          <Body>{pairing?.message ?? `Confirm this phone in Settings → Mobile access on ${desktopName}.`}</Body>
          {pairing?.deviceLabel ? <Body dim>This phone appears on the desktop as “{pairing.deviceLabel}”. Check that name before confirming.</Body> : null}
          <Button label="Cancel" kind="ghost" onPress={cancelConnect} />
        </Card>
      ) : null}

      {connecting && !pairingPending ? (
        <Card>
          <View style={styles.statusRow}>
            <ActivityIndicator color={theme.accent} />
            <Text style={styles.statusTitle}>{pairing?.message ?? `Opening an encrypted connection to ${desktopName}…`}</Text>
          </View>
          <Button label="Cancel" kind="ghost" onPress={cancelConnect} />
        </Card>
      ) : null}

      {connectionIssue && !connecting && !pairingPending ? (
        <Card style={styles.issueCard}>
          <Text accessibilityRole="alert" style={styles.issueTitle}>{connectionIssue.title}</Text>
          <Body>{connectionIssue.message}</Body>
          <Body dim>{ACTION_HINTS[connectionIssue.action]}</Body>
          <View style={styles.actions}>
            {connectionIssue.action === 'rescan' ? (
              <>
                <Button label="Scan pairing QR" onPress={() => void openScanner()} />
                {hostConfig ? <Button label="Forget this desktop" kind="ghost" onPress={forgetDesktop} /> : null}
              </>
            ) : hostConfig ? (
              <Button label="Try again" onPress={retryConnection} />
            ) : null}
          </View>
        </Card>
      ) : null}

      {discovered.length > 0 ? (
        <Card>
          <Text style={styles.label}>DESKTOPS ON THIS NETWORK</Text>
          {discovered.map(item => (
            <Pressable
              key={item.hostId}
              accessibilityRole="button"
              onPress={() => {
                setHostId(item.hostId);
                setHostName(item.displayName);
                setAddress(item.addresses[0] ?? address);
                setPort(String(item.port));
              }}
              style={({ pressed }) => [styles.discovered, pressed && styles.discoveredPressed]}
            >
              <Text style={styles.discoveredName}>{item.displayName}</Text>
              <Text style={styles.discoveredMeta}>{item.addresses[0] ?? 'Address unavailable'}:{item.port} · {item.fingerprint}</Text>
            </Pressable>
          ))}
          <Body dim>Discovery identifies a host only. Scan or paste its current pairing invitation to pin the full host key.</Body>
        </Card>
      ) : null}

      <Card>
        <Button label="Scan pairing QR" kind="ghost" onPress={() => void openScanner()} />
        {cameraPermission?.granted === false && !cameraPermission.canAskAgain ? (
          <Text style={styles.error}>Camera access is off for Praxis. Paste the invitation copied from the desktop instead, or allow the camera in iOS Settings.</Text>
        ) : null}
        <Text style={styles.label}>PAIRING INVITATION OR HOST KEY</Text>
        <TextInput
          accessibilityLabel="Pairing invitation or desktop host key"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          onChangeText={importConnectionDetails}
          placeholder="Paste the invitation copied from Praxis desktop"
          placeholderTextColor={theme.textDim}
          style={[styles.input, styles.keyInput]}
          value={invitationText}
        />
        {invitation?.tokenId ? (
          <Body dim>
            Invitation {invitation.tokenId}
            {formatClock(invitation.expiresAt) ? ` · expires ${formatClock(invitation.expiresAt)}` : ''}
          </Body>
        ) : invitation?.hostPublicKeyHex ? <Body dim>Host key pinned. A phone the desktop already trusts reconnects without an invitation.</Body> : null}
        <Text style={styles.label}>DESKTOP ADDRESS</Text>
        <TextInput accessibilityLabel="Desktop address" autoCapitalize="none" autoCorrect={false} onChangeText={setAddress} placeholder="192.168.1.2" placeholderTextColor={theme.textDim} style={styles.input} value={address} />
        <View style={styles.row}>
          <View style={styles.grow}>
            <Text style={styles.label}>PORT</Text>
            <TextInput accessibilityLabel="Desktop port" keyboardType="number-pad" onChangeText={setPort} style={styles.input} value={port} />
          </View>
          <View style={styles.grow}>
            <Text style={styles.label}>HOST ID</Text>
            <TextInput accessibilityLabel="Host ID" autoCapitalize="none" autoCorrect={false} onChangeText={setHostId} style={styles.input} value={hostId} />
          </View>
        </View>
        <Text style={styles.label}>PROJECT ID</Text>
        <TextInput accessibilityLabel="Project ID" autoCapitalize="none" autoCorrect={false} onChangeText={setProjectId} placeholder="Optional — first granted project" placeholderTextColor={theme.textDim} style={styles.input} value={projectId} />
        {formError ? <Text accessibilityRole="alert" style={styles.error}>{formError}</Text> : null}
        <Body dim>The phone’s identity key stays in this device’s secure storage.</Body>
        <Button label={connecting || pairingPending ? 'Connecting…' : invitation?.tokenId ? 'Pair and connect' : 'Connect'} disabled={connecting || pairingPending} onPress={submit} />
      </Card>

      <Modal animationType="slide" onRequestClose={() => setScannerOpen(false)} visible={scannerOpen}>
        <View style={styles.scanner}>
          <CameraView
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              importConnectionDetails(data);
              setScannerOpen(false);
            }}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.scannerGuide} />
          <Pressable accessibilityRole="button" onPress={() => setScannerOpen(false)} style={styles.scannerClose}>
            <Text style={styles.scannerCloseText}>Cancel</Text>
          </Pressable>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { marginTop: 5, color: theme.textDim, fontSize: 10, fontWeight: '700', letterSpacing: 0.7 },
  input: { minHeight: 42, paddingHorizontal: 11, paddingVertical: 9, borderWidth: 1, borderColor: theme.border, borderRadius: 8, backgroundColor: theme.input, color: theme.text, fontSize: 14 },
  keyInput: { minHeight: 82, fontSize: 12, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 10 },
  grow: { flex: 1, gap: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  error: { color: theme.danger, fontSize: 12, lineHeight: 17 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  statusTitle: { flex: 1, color: theme.text, fontSize: 15, fontWeight: '700' },
  pendingCard: { borderColor: theme.warn, backgroundColor: theme.warnSoft },
  issueCard: { borderColor: theme.danger, backgroundColor: theme.dangerSoft },
  issueTitle: { color: theme.text, fontSize: 16, fontWeight: '700' },
  discovered: { padding: 10, borderWidth: 1, borderColor: theme.border, borderRadius: 8, backgroundColor: theme.input },
  discoveredPressed: { backgroundColor: theme.surfaceRaised },
  discoveredName: { color: theme.text, fontSize: 14, fontWeight: '700' },
  discoveredMeta: { marginTop: 3, color: theme.textDim, fontSize: 10 },
  scanner: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.camera },
  scannerGuide: { width: 250, height: 250, borderWidth: 2, borderColor: theme.accent, borderRadius: 18 },
  scannerClose: { position: 'absolute', bottom: 48, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 10, backgroundColor: theme.bgSunken },
  scannerCloseText: { color: theme.text, fontSize: 15, fontWeight: '700' },
});
