import { inflateSync } from 'node:zlib';

/**
 * Read the modules of a QR code out of a PNG picture, so a login service that only hands over an image
 * (Zalo) can be drawn in the terminal like every other code. No payload is decoded: the module grid is
 * sampled from the picture and redrawn by `QrScreen`. Returns `undefined` for anything that is not a
 * plain QR picture this reader can be sure about; the caller then falls back to the image file.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Largest picture accepted (pixels): a QR login picture is a few hundred pixels wide. */
const MAX_PIXELS = 4_000_000;
const MAX_SIDE = 4096;
/** QR versions 1-40 are 21..177 modules wide in steps of 4. */
const MIN_MODULES = 21;
/** Smallest module (in pixels) that can be sampled reliably. */
const MIN_MODULE_PIXELS = 1;
const MAX_MODULES = 177;

interface Luminance {
  width: number;
  height: number;
  /** 0 (black) .. 255 (white), row-major; transparent pixels count as white. */
  data: Uint8Array;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a non-interlaced PNG (any colour type, bit depth 1-16) to luminance; `undefined` if unsupported or damaged. */
export function pngToLuminance(png: Buffer): Luminance | undefined {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) return undefined;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  let palette: Buffer | undefined;
  let transparency: Buffer | undefined;
  const data: Buffer[] = [];
  let offset = 8;
  let ended = false;
  while (offset + 12 <= png.length && !ended) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) return undefined;
    if (type === 'IHDR') {
      if (length !== 13) return undefined;
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      depth = body[8] ?? 0;
      colorType = body[9] ?? -1;
      if ((body[12] ?? 1) !== 0) return undefined; // interlaced
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') transparency = body;
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') ended = true;
    offset += 12 + length;
  }
  const channels = CHANNELS[colorType];
  if (channels === undefined || ![1, 2, 4, 8, 16].includes(depth) || data.length === 0) return undefined;
  if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) return undefined;
  if ((colorType === 2 || colorType === 4 || colorType === 6) && depth < 8) return undefined;
  if (colorType === 3 && (palette === undefined || depth > 8)) return undefined;

  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const step = Math.max(1, bitsPerPixel >> 3);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height });
  } catch {
    return undefined;
  }
  if (raw.length !== (stride + 1) * height) return undefined;

  // Undo the per-row filters in place.
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= step ? (pixels[row + x - step] ?? 0) : 0;
      const up = y > 0 ? (pixels[row - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= step ? (pixels[row - stride + x - step] ?? 0) : 0;
      const value = raw[source + x] ?? 0;
      let predicted: number;
      switch (filter) {
        case 0: predicted = 0; break;
        case 1: predicted = left; break;
        case 2: predicted = up; break;
        case 3: predicted = (left + up) >> 1; break;
        case 4: predicted = paeth(left, up, upLeft); break;
        default: return undefined;
      }
      pixels[row + x] = (value + predicted) & 0xff;
    }
  }

  const out = new Uint8Array(width * height);
  const maxSample = (1 << Math.min(depth, 8)) - 1;
  /** Sample `index` (in channel units) of row `y`, scaled to 0..255 for depths below 8, high byte for 16. */
  const sample = (y: number, index: number): number => {
    const base = y * stride;
    if (depth === 8) return pixels[base + index] ?? 0;
    if (depth === 16) return pixels[base + index * 2] ?? 0;
    const bit = index * depth;
    return ((pixels[base + (bit >> 3)] ?? 0) >> (8 - depth - (bit & 7))) & maxSample;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let value: number;
      let alpha = 255;
      if (colorType === 3) {
        const entry = sample(y, x);
        value = ((palette?.[entry * 3] ?? 0) * 299 + (palette?.[entry * 3 + 1] ?? 0) * 587 + (palette?.[entry * 3 + 2] ?? 0) * 114) / 1000;
        alpha = transparency?.[entry] ?? 255;
      } else if (colorType === 0) {
        value = depth < 8 ? (sample(y, x) * 255) / maxSample : sample(y, x);
      } else if (colorType === 4) {
        value = sample(y, x * 2);
        alpha = sample(y, x * 2 + 1);
      } else {
        value = (sample(y, x * channels) * 299 + sample(y, x * channels + 1) * 587 + sample(y, x * channels + 2) * 114) / 1000;
        if (colorType === 6) alpha = sample(y, x * 4 + 3);
      }
      out[y * width + x] = Math.round((value * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  return { width, height, data: out };
}

/** Top-left corners of the three finder patterns of an `n` x `n` code. */
const finderOrigins = (n: number): [number, number][] => [[0, 0], [0, n - 7], [n - 7, 0]];

/** The four corner modules of a 7x7 finder pattern: always dark, but pictures often round them off. */
const isFinderCorner = (r: number, c: number): boolean => (r === 0 || r === 6) && (c === 0 || c === 6);

/** True when `matrix` has the three finder patterns (rounded corners allowed) and the timing lines of a QR code. */
function looksLikeQr(matrix: boolean[][]): boolean {
  const n = matrix.length;
  const at = (row: number, column: number): boolean => matrix[row]?.[column] === true;
  const finder = (top: number, left: number): boolean => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        if (isFinderCorner(r, c)) continue;
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (at(top + r, left + c) !== (ring || core)) return false;
      }
    }
    return true;
  };
  if (!finderOrigins(n).every(([top, left]) => finder(top, left))) return false;
  for (let i = 8; i < n - 8; i++) {
    if (at(6, i) !== (i % 2 === 0) || at(i, 6) !== (i % 2 === 0)) return false;
  }
  return true;
}

/** Sample the picture as an `n` x `n` module grid laid over the bounding box of the dark pixels. */
function sample(image: Luminance, n: number, minX: number, minY: number, widthPx: number, heightPx: number): boolean[][] {
  const matrix: boolean[][] = [];
  for (let row = 0; row < n; row++) {
    const cells: boolean[] = [];
    for (let column = 0; column < n; column++) {
      const x = Math.min(image.width - 1, Math.floor(minX + ((column + 0.5) * widthPx) / n));
      const y = Math.min(image.height - 1, Math.floor(minY + ((row + 0.5) * heightPx) / n));
      cells.push((image.data[y * image.width + x] ?? 255) < 128);
    }
    matrix.push(cells);
  }
  return matrix;
}

/**
 * The module grid of the QR code in `image`, or `undefined` when no clean, square QR picture is found.
 * The code fills the bounding box of the dark pixels; every valid size (21, 25, ... 177 modules) is tried
 * and the one whose grid has all three finder patterns and both timing lines wins. The corners of the
 * finder patterns may be rounded: modules are read at their centres.
 */
export function matrixFromLuminance(image: Luminance): boolean[][] | undefined {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if ((image.data[y * image.width + x] ?? 255) >= 128) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return undefined;
  const widthPx = maxX - minX + 1;
  const heightPx = maxY - minY + 1;
  // A square picture with a few pixels of anti-aliasing slack at most.
  if (Math.abs(heightPx - widthPx) > widthPx / MIN_MODULES) return undefined;
  for (let n = MIN_MODULES; n <= MAX_MODULES && widthPx / n >= MIN_MODULE_PIXELS; n += 4) {
    const matrix = sample(image, n, minX, minY, widthPx, heightPx);
    if (looksLikeQr(matrix)) {
      // The specification makes the finder corners dark whatever the picture shows: put back the rounded-off ones.
      for (const [top, left] of finderOrigins(n)) {
        for (const r of [0, 6]) for (const c of [0, 6]) matrix[top + r]?.splice(left + c, 1, true);
      }
      return matrix;
    }
  }
  return undefined;
}

/** The module grid of the QR code in a PNG, or `undefined` (damaged, unsupported or not a QR picture). */
export function qrMatrixFromPng(png: Buffer): boolean[][] | undefined {
  const image = pngToLuminance(png);
  return image === undefined ? undefined : matrixFromLuminance(image);
}
