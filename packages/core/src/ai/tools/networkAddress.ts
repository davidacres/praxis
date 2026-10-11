import { isIP } from 'node:net';

export interface NetworkAddress { bits: 32 | 128; value: bigint; }

/** Normalize IPv6 spellings and mapped IPv4 before any policy comparison. */
export function parseNetworkAddress(raw: string): NetworkAddress | undefined {
  let address = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const family = isIP(address);
  if (family === 4) return { bits: 32, value: address.split('.').reduce((v, part) => (v << 8n) | BigInt(part), 0n) };
  if (family !== 6) return undefined;
  if (address.includes('.')) {
    const last = address.lastIndexOf(':');
    const v4 = parseNetworkAddress(address.slice(last + 1))!;
    address = address.slice(0, last + 1) + (v4.value >> 16n).toString(16) + ':' + (v4.value & 65535n).toString(16);
  }
  const halves = address.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  const value = words.reduce((v: bigint, word: string) => (v << 16n) | BigInt('0x' + word), 0n);
  if (value >> 32n === 65535n) return { bits: 32, value: value & 0xffffffffn };
  return { bits: 128, value };
}

export function addressInSubnet(address: string, subnet: string): boolean {
  const parts = subnet.split('/');
  const network = parseNetworkAddress(parts[0]);
  const peer = parseNetworkAddress(address);
  if (!network || !peer || peer.bits !== network.bits || parts.length > 2) return false;
  const prefix = parts.length === 1 ? network.bits : Number(parts[1]);
  if (!/^\d+$/.test(parts[1] ?? String(prefix)) || !Number.isInteger(prefix) || prefix < 0 || prefix > network.bits) return false;
  const shift = BigInt(network.bits - prefix);
  return peer.value >> shift === network.value >> shift;
}

/** Accept exact addresses/CIDRs; migrate only unambiguous legacy octet prefixes. */
export function normalizeMobileSubnet(raw: string): string | undefined {
  const text = raw.trim();
  if (/^(?:\d{1,3}\.){1,3}$/.test(text)) {
    const octets = text.slice(0, -1).split('.').map(Number);
    if (octets.some(x => x > 255)) return undefined;
    return [...octets, ...Array(4 - octets.length).fill(0)].join('.') + '/' + octets.length * 8;
  }
  if (!parseNetworkAddress(text.split('/')[0]) || !addressInSubnet(text.split('/')[0], text)) return undefined;
  return text;
}

/** Mobile locality is narrower than the browser's non-public-address deny set. */
export function isLocalNetworkAddress(address: string): boolean {
  return ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '::1/128', 'fc00::/7', 'fe80::/10'].some(subnet => addressInSubnet(address, subnet));
}

export function isNonPublicNetworkAddress(address: string): boolean {
  if (isLocalNetworkAddress(address)) return true;
  return ['0.0.0.0/8', '100.64.0.0/10', '224.0.0.0/4', '240.0.0.0/4', '::/128', '::/96', 'ff00::/8'].some(subnet => addressInSubnet(address, subnet));
}
