import UdpSockets from 'react-native-udp';
import { parseMobileLanDiscoveryHint } from '../renderer/mobileHostDiscovery';

const MULTICAST_ADDRESS = '239.255.90.90';
const DISCOVERY_PORT = 43199;

export interface DiscoveredMobileHost {
  hostId: string;
  displayName: string;
  fingerprint: string;
  port: number;
  addresses: readonly string[];
  lastSeenAt: number;
}

export function listenForMobileHosts(onHost: (host: DiscoveredMobileHost) => void): () => void {
  const socket = UdpSockets.createSocket({ type: 'udp4', reusePort: true }, message => {
    const hint = parseMobileLanDiscoveryHint(message.toString('utf8'));
    if (hint) onHost({ ...hint, lastSeenAt: Date.now() });
  });
  socket.bind(DISCOVERY_PORT, '0.0.0.0', () => {
    try {
      socket.addMembership(MULTICAST_ADDRESS);
    } catch {
      // Manual invitation paste remains available when multicast is blocked.
    }
  });
  return () => {
    try { socket.close(); } catch { /* already closed */ }
  };
}
