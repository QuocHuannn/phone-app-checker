import { describe, expect, it } from 'vitest';
import { qrMatrix, renderQr } from '../src/qr.ts';
import { matrixFromLuminance, pngToLuminance, qrMatrixFromPng } from '../src/qr-png.ts';
import { DARK, decode, rasterize } from './helpers/ansi-raster.ts';
import { encodePng, qrPng } from './helpers/png.ts';

const PAYLOAD = 'https://zalo.me/qr/' + 'k8Jd0sQw'.repeat(8);
const matrix = qrMatrix(PAYLOAD);

describe('reading a QR code out of a PNG', () => {
  const flavours = [
    { name: '8-bit gray', colorType: 0, depth: 8 },
    { name: '8-bit RGB', colorType: 2, depth: 8 },
    { name: '8-bit RGBA', colorType: 6, depth: 8 },
    { name: '8-bit gray+alpha', colorType: 4, depth: 8 },
    { name: '8-bit palette', colorType: 3, depth: 8 },
    { name: '1-bit gray', colorType: 0, depth: 1 },
    { name: '2-bit palette', colorType: 3, depth: 2 },
    { name: '4-bit gray', colorType: 0, depth: 4 },
    { name: '16-bit gray', colorType: 0, depth: 16 },
    { name: '16-bit RGB', colorType: 2, depth: 16 },
  ] as const;

  for (const flavour of flavours) {
    for (const filters of [false, true]) {
      it(`${flavour.name}${filters ? ' with all five row filters' : ''}: gives back exactly the modules, which then scan`, () => {
        const png = qrPng(matrix, { scale: 5, margin: 4, colorType: flavour.colorType, depth: flavour.depth, filters });
        expect(qrMatrixFromPng(png)).toEqual(matrix);
      });
    }
  }

  it('works for other module sizes, margins and QR versions', () => {
    for (const payload of ['x', 'https://line.me/R/au/q/' + 'a'.repeat(120), '2@' + 'q'.repeat(200)]) {
      const modules = qrMatrix(payload);
      for (const [scale, margin] of [[1, 0], [3, 2], [7, 10], [10, 1]] as const) {
        const png = qrPng(modules, { scale, margin, colorType: 2, depth: 8 });
        expect(qrMatrixFromPng(png), `${payload.length} chars, scale ${scale}, margin ${margin}`).toEqual(modules);
      }
    }
  });

  it('end to end: PNG -> modules -> the terminal rendering decodes to the original payload', () => {
    const modulesFromPicture = qrMatrixFromPng(qrPng(matrix, { scale: 4, margin: 3, colorType: 6, depth: 8 }));
    expect(modulesFromPicture).toBeDefined();
    expect(decode(rasterize(renderQr(modulesFromPicture ?? [], 'color256', 4), DARK))).toBe(PAYLOAD);
  });

  it('still reads a code with a logo-sized white hole in the middle (only the covered modules differ)', () => {
    const read = qrMatrixFromPng(qrPng(matrix, { scale: 6, margin: 4, colorType: 2, depth: 8, hole: true }));
    expect(read).toBeDefined();
    const differing = (read ?? []).flatMap((row, r) => row.filter((cell, c) => cell !== matrix[r]?.[c]));
    expect(differing.length).toBeGreaterThan(0);
    expect(differing.length).toBeLessThan(matrix.length ** 2 / 10);
    // The finder patterns and timing lines are intact, so the shape is recognised and decoding can use error correction.
    expect(read?.slice(0, 7).map((row) => row.slice(0, 7))).toEqual(matrix.slice(0, 7).map((row) => row.slice(0, 7)));
  });

  it("reads the shape of Zalo's real login picture: 399 px, 9 px modules, 15 px margin, rounded finder corners", () => {
    const payload = 'http://zaloapp.com/qr/l?tk=zaloqr:v2_' + 'M3XMKLOkCIunDpan'.repeat(5);
    const modules = qrMatrix(payload);
    expect(modules).toHaveLength(41);
    const side = 399;
    const origin = 15;
    const module = 9;
    const radius = 22; // corner rounding of the finder patterns in pixels: cuts the corner modules' centres, as the real picture does
    const finderOrigins = [[0, 0], [0, 34], [34, 0]] as const;
    const rows: Buffer[] = [];
    for (let y = 0; y < side; y++) {
      const row = Buffer.alloc(side * 4, 255);
      for (let x = 0; x < side; x++) {
        const r = Math.floor((y - origin) / module);
        const c = Math.floor((x - origin) / module);
        let dark = y >= origin && x >= origin && modules[r]?.[c] === true;
        for (const [fr, fc] of finderOrigins) {
          // Whiten the pixels outside a quarter circle at each outer corner of a finder pattern.
          const left = origin + fc * module;
          const top = origin + fr * module;
          const size = 7 * module;
          for (const [cx, cy, dx, dy] of [[left, top, 1, 1], [left + size - 1, top, -1, 1], [left, top + size - 1, 1, -1], [left + size - 1, top + size - 1, -1, -1]] as const) {
            const inCorner = (x - cx) * dx >= 0 && (x - cx) * dx < radius && (y - cy) * dy >= 0 && (y - cy) * dy < radius;
            if (inCorner && Math.hypot((x - cx) * dx - radius, (y - cy) * dy - radius) > radius) dark = false;
          }
        }
        const v = dark ? 0 : 255;
        row.set([v, v, v, 255], x * 4);
      }
      rows.push(row);
    }
    const picture = encodePng({ width: side, height: side, colorType: 6, depth: 8, rows, filters: true });
    const read = qrMatrixFromPng(picture);
    expect(read).toEqual(modules);
    expect(decode(rasterize(renderQr(read ?? [], 'color256', 2), DARK))).toBe(payload);
  });

  it('refuses anything that is not a plain QR picture, instead of drawing garbage', () => {
    expect(qrMatrixFromPng(Buffer.from('not a png at all, just text that is long enough to pass the length check'))).toBeUndefined();
    expect(qrMatrixFromPng(Buffer.alloc(0))).toBeUndefined();
    const good = qrPng(matrix, { scale: 4, margin: 4, colorType: 2, depth: 8 });
    expect(qrMatrixFromPng(good.subarray(0, good.length - 40))).toBeUndefined(); // truncated
    expect(qrMatrixFromPng(qrPng(matrix, { scale: 4, margin: 4, colorType: 2, depth: 8, interlace: true }))).toBeUndefined();

    const black = Buffer.alloc(100, 0);
    const blackSquare = encodePng({ width: 100, height: 100, colorType: 0, depth: 8, rows: Array.from({ length: 100 }, () => black) });
    expect(qrMatrixFromPng(blackSquare)).toBeUndefined();
    const white = encodePng({ width: 60, height: 60, colorType: 0, depth: 8, rows: Array.from({ length: 60 }, () => Buffer.alloc(60, 255)) });
    expect(qrMatrixFromPng(white)).toBeUndefined();

    // A QR picture with a corner pattern erased is not trusted.
    const damaged = matrix.map((row) => [...row]);
    for (let r = 0; r < 7; r++) for (let c = damaged.length - 7; c < damaged.length; c++) damaged[r]?.splice(c, 1, false);
    expect(qrMatrixFromPng(qrPng(damaged, { scale: 4, margin: 4, colorType: 2, depth: 8 }))).toBeUndefined();
  });

  it('bounds the picture size', () => {
    const huge = encodePng({ width: 5000, height: 1, colorType: 0, depth: 8, rows: [Buffer.alloc(5000, 255)] });
    expect(pngToLuminance(huge)).toBeUndefined();
  });

  it('reports luminance with transparency over white', () => {
    const png = encodePng({ width: 2, height: 1, colorType: 6, depth: 8, rows: [Buffer.from([0, 0, 0, 0, 0, 0, 0, 255])] });
    expect([...(pngToLuminance(png)?.data ?? [])]).toEqual([255, 0]);
  });

  it('matrixFromLuminance rejects pictures whose width and height disagree', () => {
    const data = new Uint8Array(100 * 40).fill(255);
    for (let x = 10; x < 80; x++) for (let y = 5; y < 12; y++) data[y * 100 + x] = 0;
    expect(matrixFromLuminance({ width: 100, height: 40, data })).toBeUndefined();
  });
});
