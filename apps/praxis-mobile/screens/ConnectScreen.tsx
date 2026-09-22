import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Body, Button, Card, H1, Screen } from '../app/ui';
import { useStore } from '../app/store';
import { theme } from '../app/theme';
import { loadMobileHostConfiguration } from '../app/mobileConnection';
import { listenForMobileHosts, type DiscoveredMobileHost } from '../app/mobileDiscovery';

export function ConnectScreen(): React.JSX.Element {
  const { shell, connect, connectionError } = useStore();
  const connecting = shell.connection === 'connecting';
  const [address, setAddress] = useState('192.168.1.2');
  const [port, setPort] = useState('43100');
  const [hostId, setHostId] = useState('praxis-desktop');
  const [hostName, setHostName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [hostPublicKeyHex, setHostPublicKeyHex] = useState('');
  const [discovered, setDiscovered] = useState<DiscoveredMobileHost[]>([]);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();

  useEffect(() => {
    let live = true;
    void loadMobileHostConfiguration().then(config => {
      if (!live || !config) return;
      setAddress(config.address);
      setPort(String(config.port));
      setHostId(config.hostId);
      setHostName(config.hostName ?? '');
      setProjectId(config.projectId ?? '');
      setHostPublicKeyHex(config.hostPublicKeyHex);
      void connect(config);
    });
    return () => { live = false; };
  }, []);

  useEffect(() => listenForMobileHosts(host => {
    setDiscovered(previous => [host, ...previous.filter(item => item.hostId !== host.hostId)].slice(0, 5));
  }), []);

  const importConnectionDetails = (value: string): void => {
    setHostPublicKeyHex(value);
    if (value.startsWith('P1|')) {
      const [, compactHostId, compactKey, endpoint] = value.split('|');
      const separator = endpoint?.lastIndexOf(':') ?? -1;
      if (compactHostId) setHostId(compactHostId);
      if (compactKey) setHostPublicKeyHex(compactKey);
      if (endpoint && separator > 0) {
        setAddress(endpoint.slice(0, separator));
        setPort(endpoint.slice(separator + 1));
      }
      return;
    }
    try {
      const parsed = JSON.parse(value) as {
        hostId?: unknown;
        displayName?: unknown;
        hostName?: unknown;
        port?: unknown;
        publicKeyHex?: unknown;
        addresses?: unknown;
        endpoints?: unknown;
      };
      if (typeof parsed.hostId === 'string') setHostId(parsed.hostId);
      if (typeof parsed.displayName === 'string') setHostName(parsed.displayName);
      if (typeof parsed.hostName === 'string') setHostName(parsed.hostName);
      if (typeof parsed.port === 'number') setPort(String(parsed.port));
      if (typeof parsed.publicKeyHex === 'string') setHostPublicKeyHex(parsed.publicKeyHex);
      if (Array.isArray(parsed.addresses) && typeof parsed.addresses[0] === 'string') setAddress(parsed.addresses[0]);
      if (Array.isArray(parsed.endpoints)) {
        const endpoint = parsed.endpoints[0] as { address?: unknown; port?: unknown } | undefined;
        if (typeof endpoint?.address === 'string') setAddress(endpoint.address);
        if (typeof endpoint?.port === 'number') setPort(String(endpoint.port));
      }
    } catch {
      // A raw public key remains a supported manual setup path.
    }
  };

  const openScanner = async (): Promise<void> => {
    const permission = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    if (permission.granted) setScannerOpen(true);
  };

  const submit = (): void => {
    const parsedPort = Number(port);
    if (!address.trim() || !hostId.trim() || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) return;
    void connect({
      address: address.trim(),
      port: parsedPort,
      hostId: hostId.trim(),
      ...(hostName.trim() ? { hostName: hostName.trim() } : {}),
      hostPublicKeyHex: hostPublicKeyHex.trim(),
      ...(projectId.trim() ? { projectId: projectId.trim() } : {}),
    });
  };

  return (
    <Screen>
      <H1>Praxis</H1>
      <Card>
        <Body>Continue and act on work running on your desktop host.</Body>
        <Body dim>
          Pair once with a QR code from the desktop; after that the phone finds the host on your network and connects over an
          encrypted channel.
        </Body>
      </Card>
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
          <Body dim>Discovery identifies a host only. Paste its current pairing invitation below to pin the full host key.</Body>
        </Card>
      ) : null}
      <Card>
        <Text style={styles.label}>DESKTOP ADDRESS</Text>
        <TextInput accessibilityLabel="Desktop address" autoCapitalize="none" autoCorrect={false} onChangeText={setAddress} style={styles.input} value={address} />
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
        <TextInput accessibilityLabel="Project ID" autoCapitalize="none" autoCorrect={false} onChangeText={setProjectId} placeholder="Optional" placeholderTextColor={theme.textDim} style={styles.input} value={projectId} />
        <Text style={styles.label}>CONNECTION DETAILS OR HOST PUBLIC KEY</Text>
        <TextInput
          accessibilityLabel="Desktop host public key"
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          onChangeText={importConnectionDetails}
          placeholder="Paste the connection details copied from Praxis desktop"
          placeholderTextColor={theme.textDim}
          style={[styles.input, styles.keyInput]}
          value={hostPublicKeyHex}
        />
        <Button label="Scan pairing QR" kind="ghost" onPress={() => void openScanner()} />
        {cameraPermission?.granted === false && !cameraPermission.canAskAgain ? (
          <Text style={styles.error}>Camera access is disabled. Paste the invitation copied from the desktop instead.</Text>
        ) : null}
        {connectionError ? <Text accessibilityRole="alert" style={styles.error}>{connectionError}</Text> : null}
        <Body dim>{connecting ? 'Opening encrypted connection…' : 'The device key remains in secure device storage.'}</Body>
        <Button label={connecting ? 'Connecting…' : 'Connect'} onPress={submit} />
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
  error: { color: theme.danger, fontSize: 12, lineHeight: 17 },
  discovered: { padding: 10, borderWidth: 1, borderColor: theme.border, borderRadius: 8, backgroundColor: theme.input },
  discoveredPressed: { backgroundColor: theme.surfaceRaised },
  discoveredName: { color: theme.text, fontSize: 14, fontWeight: '700' },
  discoveredMeta: { marginTop: 3, color: theme.textDim, fontSize: 10 },
  scanner: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' },
  scannerGuide: { width: 250, height: 250, borderWidth: 2, borderColor: theme.accent, borderRadius: 18 },
  scannerClose: { position: 'absolute', bottom: 48, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 10, backgroundColor: theme.bgSunken },
  scannerCloseText: { color: theme.text, fontSize: 15, fontWeight: '700' },
});
