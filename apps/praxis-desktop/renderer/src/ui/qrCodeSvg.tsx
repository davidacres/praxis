/**
 * A QR code for the mobile pairing invitation: byte mode, error correction M,
 * the smallest version (1–10) that holds the payload, and the mask with the
 * lowest penalty — a standard QR any phone camera reads. The pairing payload
 * is ~160 bytes, so it needs version 9; nothing is truncated.
 */

/** Error correction M, per version: EC codewords per block, then [block count, data codewords] groups. */
const ECC_M: ReadonlyArray<readonly [number, ReadonlyArray<readonly [number, number]>]> = [
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];
const ALIGNMENT: ReadonlyArray<readonly number[]> = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];
const QUIET_ZONE = 4;

function gfMul(a: number, b: number): number {
  let product = 0;
  for (let i = 7; i >= 0; i -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((b >>> i) & 1) * a;
  }
  return product & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = Array<number>(degree - 1).fill(0);
  result.push(1);
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, i) => { result[i]! ^= gfMul(coefficient, factor); });
  }
  return result;
}

/** Data plus interleaved error correction for `version`, or undefined when the payload does not fit. */
function codewords(bytes: readonly number[], version: number): number[] | undefined {
  const [ecLength, groups] = ECC_M[version - 1]!;
  const capacity = groups.reduce((sum, [count, length]) => sum + count * length, 0);
  const countBits = version < 10 ? 8 : 16;
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits);
  for (const byte of bytes) push(byte, 8);
  if (bits.length > capacity * 8) return undefined;
  push(0, Math.min(4, capacity * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const divisor = rsDivisor(ecLength);
  const blocks: Array<{ data: number[]; ec: number[] }> = [];
  let offset = 0;
  for (const [count, length] of groups) {
    for (let b = 0; b < count; b += 1) {
      const block = data.slice(offset, offset + length);
      offset += length;
      blocks.push({ data: block, ec: rsRemainder(block, divisor) });
    }
  }
  const out: number[] = [];
  const longest = Math.max(...blocks.map(block => block.data.length));
  for (let i = 0; i < longest; i += 1) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]!);
  for (let i = 0; i < ecLength; i += 1) for (const block of blocks) out.push(block.ec[i]!);
  return out;
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

class Grid {
  readonly version: number;
  readonly size: number;
  readonly modules: boolean[][];
  readonly reserved: boolean[][];

  constructor(version: number) {
    this.version = version;
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => Array<boolean>(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.reserved[y]![x] = true;
  }

  drawFunctionPatterns(): void {
    const { size, version } = this;
    for (let i = 0; i < size; i += 1) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          const distance = Math.max(Math.abs(dx), Math.abs(dy));
          this.set(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
    const positions = ALIGNMENT[version - 1]!;
    const last = positions.length - 1;
    positions.forEach((cx, i) => positions.forEach((cy, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) this.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    this.drawFormat(0);
    if (version >= 7) {
      let remainder = version;
      for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
      const bits = (version << 12) | remainder;
      for (let i = 0; i < 18; i += 1) {
        const dark = ((bits >>> i) & 1) === 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, dark);
        this.set(b, a, dark);
      }
    }
  }

  /** Format information for error correction M (level bits 00) and `mask`. */
  drawFormat(mask: number): void {
    const data = mask;
    let remainder = data;
    for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
    const { size } = this;
    for (let i = 0; i <= 5; i += 1) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) this.set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) this.set(8, size - 15 + i, bit(i));
    this.set(8, size - 8, true);
  }

  drawCodewords(data: readonly number[]): void {
    const { size } = this;
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vertical = 0; vertical < size; vertical += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vertical : vertical;
          if (this.reserved[y]![x] || i >= data.length * 8) continue;
          this.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i += 1;
        }
      }
    }
  }

  applyMask(mask: number): void {
    const test = MASKS[mask]!;
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (!this.reserved[y]![x] && test(x, y)) this.modules[y]![x] = !this.modules[y]![x];
      }
    }
  }

  penalty(): number {
    const { size, modules } = this;
    let score = 0;
    const line = (get: (i: number, j: number) => boolean): void => {
      for (let i = 0; i < size; i += 1) {
        let run = 1;
        const values: boolean[] = [];
        for (let j = 0; j < size; j += 1) {
          values.push(get(i, j));
          if (j > 0 && get(i, j) === get(i, j - 1)) {
            run += 1;
            if (run === 5) score += 3;
            else if (run > 5) score += 1;
          } else if (j > 0) {
            run = 1;
          }
        }
        const text = values.map(v => (v ? '1' : '0')).join('');
        for (const pattern of ['10111010000', '00001011101']) {
          for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) score += 40;
        }
      }
    };
    line((i, j) => modules[i]![j]!);
    line((i, j) => modules[j]![i]!);
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const c = modules[y]![x];
        if (c === modules[y]![x + 1] && c === modules[y + 1]![x] && c === modules[y + 1]![x + 1]) score += 3;
      }
    }
    const dark = modules.flat().filter(Boolean).length;
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/** The QR modules for `payload` (true = dark), without the quiet zone. */
export function qrMatrix(payload: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(payload)];
  for (let version = 1; version <= ECC_M.length; version += 1) {
    const data = codewords(bytes, version);
    if (!data) continue;
    let best: Grid | undefined;
    let bestScore = Infinity;
    for (let mask = 0; mask < MASKS.length; mask += 1) {
      const grid = new Grid(version);
      grid.drawFunctionPatterns();
      grid.drawCodewords(data);
      grid.applyMask(mask);
      grid.drawFormat(mask);
      const score = grid.penalty();
      if (score < bestScore) {
        best = grid;
        bestScore = score;
      }
    }
    return best!.modules;
  }
  throw new Error(`The pairing payload (${bytes.length} bytes) is too long for a QR code.`);
}

export function QrCodeSvg({ payload, title }: { payload: string; title: string }) {
  const matrix = qrMatrix(payload);
  const dim = matrix.length + QUIET_ZONE * 2;
  const cells = matrix.flatMap((row, y) =>
    row.flatMap((on, x) => (on ? `<rect x="${x + QUIET_ZONE}" y="${y + QUIET_ZONE}" width="1" height="1" />` : [])),
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
