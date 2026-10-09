import jsQR from 'jsqr';

// jsqr's typings describe the module namespace, but the module itself is the decoder function.
const jsqr = jsQR as unknown as typeof jsQR.default;

/**
 * What a terminal would put on the screen, as pixels: ANSI colour codes and block glyphs are drawn the
 * way a terminal draws them (a cell is S pixels wide and 2*S high, an upper half block fills the top
 * half with the foreground colour and the bottom half with the background colour), then a phone camera's
 * decoder (jsQR) reads the picture. Lets tests prove that the exact bytes written to the terminal scan.
 */

export type Rgb = readonly [number, number, number];
export interface Theme {
  /** Terminal default text and background colours (what unstyled output is drawn with). */
  fg: Rgb;
  bg: Rgb;
}

/** Typical dark and light terminal themes: the text colour is never pure black or white. */
export const DARK: Theme = { fg: [0xd0, 0xd0, 0xd0], bg: [0x1e, 0x1e, 0x1e] };
export const LIGHT: Theme = { fg: [0x30, 0x30, 0x30], bg: [0xf5, 0xf5, 0xf5] };

const BASIC: Rgb[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];

function palette256(index: number): Rgb {
  if (index < 16) return BASIC[index] ?? [0, 0, 0];
  if (index >= 232) {
    const level = 8 + 10 * (index - 232);
    return [level, level, level];
  }
  const cube = index - 16;
  const level = (n: number): number => (n === 0 ? 0 : 55 + 40 * n);
  return [level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6)];
}

export interface Raster {
  width: number;
  height: number;
  /** RGBA, as jsQR wants it. */
  data: Uint8ClampedArray;
}

/** Draw `output` (text with ANSI colour codes, `\n` between rows) with `theme` as the default colours. */
export function rasterize(output: string, theme: Theme, scale = 4): Raster {
  const rows: { top: Rgb; bottom: Rgb }[][] = [[]];
  let fg = theme.fg;
  let bg = theme.bg;
  for (let i = 0; i < output.length; ) {
    const char = output[i] ?? '';
    if (char === '\u001b') {
      const end = output.indexOf('m', i);
      const params = output.slice(i + 2, end).split(';').map(Number);
      for (let p = 0; p < params.length; p++) {
        const code = params[p] ?? 0;
        if (code === 0) [fg, bg] = [theme.fg, theme.bg];
        else if (code === 39) fg = theme.fg;
        else if (code === 49) bg = theme.bg;
        else if (code === 38 && params[p + 1] === 5) fg = palette256(params[(p += 2)] ?? 0);
        else if (code === 48 && params[p + 1] === 5) bg = palette256(params[(p += 2)] ?? 0);
        else if (code >= 30 && code <= 37) fg = BASIC[code - 30] ?? fg;
        else if (code >= 90 && code <= 97) fg = BASIC[code - 90 + 8] ?? fg;
        else if (code >= 40 && code <= 47) bg = BASIC[code - 40] ?? bg;
        else if (code >= 100 && code <= 107) bg = BASIC[code - 100 + 8] ?? bg;
      }
      i = end + 1;
      continue;
    }
    i++;
    if (char === '\n') {
      rows.push([]);
      continue;
    }
    const row = rows[rows.length - 1];
    if (char === '\u2580') row?.push({ top: fg, bottom: bg });
    else if (char === '\u2584') row?.push({ top: bg, bottom: fg });
    else if (char === '\u2588' || char === '#') row?.push({ top: fg, bottom: fg });
    else row?.push({ top: bg, bottom: bg });
  }
  // A margin of terminal background around the output, as on a real screen.
  const margin = 3;
  const columns = Math.max(...rows.map((row) => row.length)) + 2 * margin;
  const cellRows = rows.length + 2;
  const width = columns * scale;
  const height = cellRows * 2 * scale;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const cellRow = Math.floor(y / (2 * scale));
    const upper = y % (2 * scale) < scale;
    const row = rows[cellRow - 1];
    for (let x = 0; x < width; x++) {
      const cell = row?.[Math.floor(x / scale) - margin];
      const color = cell === undefined ? theme.bg : upper ? cell.top : cell.bottom;
      const at = (y * width + x) * 4;
      data[at] = color[0];
      data[at + 1] = color[1];
      data[at + 2] = color[2];
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

/** The payload jsQR reads from the picture, or `null`. `invert: false` = a decoder that never tries inverted codes. */
export function decode(raster: Raster, invert = false): string | null {
  return jsqr(raster.data, raster.width, raster.height, { inversionAttempts: invert ? 'attemptBoth' : 'dontInvert' })?.data ?? null;
}
