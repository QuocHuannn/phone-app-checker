import { crc32, deflateSync } from 'node:zlib';

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}

export interface PngSpec {
  width: number;
  height: number;
  /** PNG colour type: 0 gray, 2 RGB, 3 palette, 4 gray+alpha, 6 RGBA. */
  colorType: 0 | 2 | 3 | 4 | 6;
  /** Bits per sample: 1, 2, 4, 8 or 16 (1-4 only for gray and palette). */
  depth: 1 | 2 | 4 | 8 | 16;
  /** Rows of raw bytes, already packed for `depth` / `colorType` (no filter byte). */
  rows: Buffer[];
  palette?: Buffer;
  interlace?: boolean;
  /** Use all five filter types, cycling by row, instead of "none". */
  filters?: boolean;
}

const channelsOf = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as const;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Encode a PNG; the filters are applied the way an encoder does, so the reader's unfiltering is exercised. */
export function encodePng(spec: PngSpec): Buffer {
  const bpp = Math.max(1, (channelsOf[spec.colorType] * spec.depth) >> 3);
  const raw: Buffer[] = [];
  spec.rows.forEach((row, y) => {
    const type = spec.filters === true ? y % 5 : 0;
    const prior = spec.rows[y - 1];
    const out = Buffer.alloc(row.length + 1);
    out[0] = type;
    for (let x = 0; x < row.length; x++) {
      const left = x >= bpp ? (row[x - bpp] ?? 0) : 0;
      const up = prior?.[x] ?? 0;
      const upLeft = x >= bpp ? (prior?.[x - bpp] ?? 0) : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][type] ?? 0;
      out[x + 1] = ((row[x] ?? 0) - predicted) & 0xff;
    }
    raw.push(out);
  });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(spec.width, 0);
  ihdr.writeUInt32BE(spec.height, 4);
  ihdr[8] = spec.depth;
  ihdr[9] = spec.colorType;
  ihdr[12] = spec.interlace === true ? 1 : 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    ...(spec.palette === undefined ? [] : [chunk('PLTE', spec.palette)]),
    chunk('IDAT', deflateSync(Buffer.concat(raw))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A QR picture: `matrix` drawn at `scale` pixels per module with a white margin of `margin` modules, in the given PNG flavour. */
export function qrPng(
  matrix: boolean[][],
  options: { scale: number; margin: number; colorType: PngSpec['colorType']; depth: PngSpec['depth']; filters?: boolean; interlace?: boolean; hole?: boolean },
): Buffer {
  const side = (matrix.length + 2 * options.margin) * options.scale;
  const holeSize = options.hole === true ? Math.floor(side / 6) : 0;
  const dark = (x: number, y: number): boolean => {
    const row = Math.floor(y / options.scale) - options.margin;
    const column = Math.floor(x / options.scale) - options.margin;
    // A logo-like white square in the middle of the code (many login QR pictures have one).
    if (Math.abs(x - side / 2) < holeSize / 2 && Math.abs(y - side / 2) < holeSize / 2) return false;
    return matrix[row]?.[column] === true;
  };
  const rows: Buffer[] = [];
  for (let y = 0; y < side; y++) {
    const pixels: number[][] = [];
    for (let x = 0; x < side; x++) {
      const v = dark(x, y) ? 0 : 255;
      pixels.push(
        options.colorType === 2 ? [v, v, v] : options.colorType === 6 ? [v, v, v, 255] : options.colorType === 4 ? [v, 255] : [v],
      );
    }
    if (options.depth === 8 && options.colorType !== 3) {
      rows.push(Buffer.from(pixels.flat()));
    } else if (options.depth === 16) {
      rows.push(Buffer.from(pixels.flat().flatMap((v) => [v, v])));
    } else {
      // Packed samples: palette index 0 = black, 1 = white (palette) or gray levels 0 / max.
      const max = (1 << options.depth) - 1;
      const bytes = Buffer.alloc(Math.ceil((side * options.depth) / 8));
      pixels.forEach((pixel, x) => {
        const sample = (pixel[0] ?? 0) === 0 ? 0 : options.colorType === 3 ? 1 : max;
        const bit = x * options.depth;
        bytes[bit >> 3] = (bytes[bit >> 3] ?? 0) | (sample << (8 - options.depth - (bit & 7)));
      });
      rows.push(bytes);
    }
  }
  return encodePng({
    width: side,
    height: side,
    colorType: options.colorType,
    depth: options.depth,
    rows,
    filters: options.filters,
    interlace: options.interlace,
    palette: options.colorType === 3 ? Buffer.from([0, 0, 0, 255, 255, 255]) : undefined,
  });
}
