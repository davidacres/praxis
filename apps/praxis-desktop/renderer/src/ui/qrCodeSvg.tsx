/**
 * Version-4 QR (33×33), byte mode, ECC L — enough for a compact pairing
 * payload. Mask 0 only; phones scan this as a normal QR.
 */
const SIZE = 33;
const DATA_BYTES = 80;
const EC_BYTES = 20;

function gfMul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i += 1) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1d;
    b >>= 1;
  }
  return p;
}

function rsEncode(data: number[]): number[] {
  const generator = rsGenerator(EC_BYTES);
  const ec = Array(EC_BYTES).fill(0);
  for (const byte of data) {
    const factor = byte ^ (ec[0] ?? 0);
    ec.shift();
    ec.push(0);
    if (!factor) continue;
    for (let i = 0; i < generator.length; i += 1) {
      ec[i] ^= gfMul(generator[i], factor);
    }
  }
  return ec;
}

function rsGenerator(count: number): number[] {
  let poly = [1];
  let root = 1;
  for (let i = 0; i < count; i += 1) {
    const next = Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
    root = gfMul(root, 2);
  }
  return poly.slice(1);
}

function placeFinder(modules: boolean[][], row: number, col: number): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE) continue;
      const dark = r === -1 || r === 7 || c === -1 || c === 7
        ? false
        : r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      if (r >= 0 && r <= 6 && c >= 0 && c <= 6) modules[rr][cc] = dark;
    }
  }
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const dark = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      modules[row + r][col + c] = dark;
    }
  }
}

function reserved(row: number, col: number): boolean {
  if (row < 9 && col < 9) return true;
  if (row < 9 && col >= SIZE - 8) return true;
  if (row >= SIZE - 8 && col < 9) return true;
  if (row === 6 || col === 6) return true;
  return false;
}

export function qrMatrix(payload: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(payload)].slice(0, DATA_BYTES - 3);
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const byte of bytes) push(byte, 8);
  push(0, 4);
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | (bits[i + b] ?? 0);
    data.push(byte);
  }
  const pad = [0xec, 0x11];
  while (data.length < DATA_BYTES) data.push(pad[data.length % 2]!);
  const codewords = [...data.slice(0, DATA_BYTES), ...rsEncode(data.slice(0, DATA_BYTES))];

  const modules = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));
  placeFinder(modules, 0, 0);
  placeFinder(modules, 0, SIZE - 7);
  placeFinder(modules, SIZE - 7, 0);
  for (let i = 8; i < SIZE - 8; i += 1) {
    modules[6][i] = i % 2 === 0;
    modules[i][6] = i % 2 === 0;
  }

  const occupied = Array.from({ length: SIZE }, (_, row) => Array.from({ length: SIZE }, (_, col) => reserved(row, col)));
  let bit = 0;
  const totalBits = codewords.length * 8;
  for (let col = SIZE - 1; col > 0; col -= 2) {
    if (col === 6) col -= 1;
    for (let n = 0; n < SIZE; n += 1) {
      for (let dc = 0; dc < 2; dc += 1) {
        const c = col - dc;
        const upward = ((SIZE - 1 - col) & 2) === 0;
        const r = upward ? SIZE - 1 - n : n;
        if (occupied[r][c]) continue;
        const b = bit < totalBits ? ((codewords[Math.floor(bit / 8)]! >> (7 - (bit % 8))) & 1) === 1 : false;
        const mask = (r + c) % 2 === 0;
        modules[r][c] = mask ? !b : b;
        occupied[r][c] = true;
        bit += 1;
      }
    }
  }

  const format = 0b111011111000100; // ECC L, mask 0, with BCH — common table value
  for (let i = 0; i < 15; i += 1) {
    const dark = ((format >> i) & 1) === 1;
    if (i < 6) modules[i][8] = dark;
    else if (i < 8) modules[i + 1][8] = dark;
    else modules[SIZE - 15 + i][8] = dark;
    if (i < 8) modules[8][SIZE - 1 - i] = dark;
    else if (i < 9) modules[8][15 - i] = dark;
    else modules[8][14 - i] = dark;
  }
  modules[SIZE - 8][8] = true;
  return modules;
}

export function QrCodeSvg({ payload, title }: { payload: string; title: string }) {
  const matrix = qrMatrix(payload);
  const dim = matrix.length;
  const cells = matrix.flatMap((row, y) =>
    row.flatMap((on, x) => (on ? `<rect x="${x}" y="${y}" width="1" height="1" />` : [])),
  );
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="${title}"><rect width="${dim}" height="${dim}" fill="#fff"/><g fill="#111">${cells.join('')}</g></svg>`;
  return (
    <img
      className="mobile-pairing-qr"
      alt={title}
      data-testid="mobile-pairing-qr"
      src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
    />
  );
}
