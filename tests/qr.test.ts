import { createHash } from 'node:crypto';
import qrcodeTerminal from 'qrcode-terminal';
import { describe, expect, it } from 'vitest';
import { detectMode, frameSize, qrMatrix, qrWindowNeed, QrScreen, renderQr, visualRows, type QrMode, type QrStream } from '../src/qr.ts';
import { DARK, decode, LIGHT, rasterize } from './helpers/ansi-raster.ts';

const b64 = (seed: string, bytes: number): string => createHash('sha512').update(seed).digest().subarray(0, bytes).toString('base64');

/** WhatsApp Web's QR payload: `ref,publicKey,secret,deviceId` (about 200 characters; base64 parts). */
const WHATSAPP = `2@${b64('ref', 64)},${b64('pub', 32)},${b64('secret', 32)},${b64('id', 16)}`;
/** LINE and Zalo QR links, and Telegram's `tg://login` token. */
const LINE = `https://line.me/R/au/q/${b64('line', 24).replace(/[+/=]/g, 'x')}?secret=${b64('s', 32).replace(/[+/=]/g, 'y')}&e2eeVersion=1`;
const ZALO = `https://zalo.me/qr/${b64('zalo', 40).replace(/[+/=]/g, 'z')}`;
const TELEGRAM = `tg://login?token=${b64('tg', 32).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')}`;
/** What WhatsApp Web really shows today (decoded from a live capture in the release smoke): the same four parts, wrapped in a link, with a trailing "1". 277 characters, 61 modules. */
const WHATSAPP_LINK = `https://wa.me/settings/linked_devices#2@${(b64('ref2a', 64) + b64('ref2b', 64)).slice(0, 118)},${b64('pub2', 32)},${b64('secret2', 32)},${b64('id2', 16)},1`;
const PAYLOADS: [string, string][] = [
  ['WhatsApp', WHATSAPP],
  ['WhatsApp (link form, 61 modules)', WHATSAPP_LINK],
  ['LINE', LINE],
  ['Zalo', ZALO],
  ['Telegram', TELEGRAM],
];

describe('test payloads', () => {
  it('are realistic in size', () => {
    expect(WHATSAPP.length).toBeGreaterThan(190);
    expect(WHATSAPP.length).toBeLessThan(215);
    expect(WHATSAPP).toMatch(/^2@[A-Za-z0-9+/=]+,[A-Za-z0-9+/=]+,[A-Za-z0-9+/=]+,[A-Za-z0-9+/=]+$/);
    expect(WHATSAPP_LINK.length).toBeGreaterThan(260);
    expect(qrMatrix(WHATSAPP_LINK)).toHaveLength(61);
  });
});

describe('explicit-colour rendering scans on dark and light terminals', () => {
  for (const [name, payload] of PAYLOADS) {
    for (const mode of ['color256', 'color16'] as const) {
      for (const quiet of [4, 2]) {
        it(`${name}: ${mode}, quiet zone ${quiet}, dark and light theme, decoder that never inverts`, () => {
          const output = renderQr(payload, mode, quiet);
          expect(decode(rasterize(output, DARK))).toBe(payload);
          expect(decode(rasterize(output, LIGHT))).toBe(payload);
        });
      }
    }
  }

  it('scans from a terminal whose own colours are hostile (white on white, and the reverse)', () => {
    const output = renderQr(WHATSAPP, 'color256', 2);
    expect(decode(rasterize(output, { fg: [255, 255, 255], bg: [255, 255, 255] }))).toBe(WHATSAPP);
    expect(decode(rasterize(output, { fg: [0, 0, 0], bg: [0, 0, 0] }))).toBe(WHATSAPP);
  });

  it('uses only explicit colours: no default-colour glyph carries part of the picture', () => {
    const output = renderQr(WHATSAPP, 'color256', 4);
    for (const line of output.split('\n')) {
      // Every row is: indent, then (colour code, half blocks)*, then a reset; blanks and full blocks never appear.
      expect(line).toMatch(/^ {2}(\u001b\[38;5;(16|231);48;5;(16|231)m\u2580+)+\u001b\[0m$/);
    }
  });

  it('draws a white quiet zone of at least 2 modules on every side', () => {
    const matrix = qrMatrix(WHATSAPP);
    for (const quiet of [2, 4]) {
      const raster = rasterize(renderQr(matrix, 'color256', quiet), DARK, 1);
      // Cell (column c, row r) is two pixels tall: find white pixels along the first and last drawn rows.
      const white = (x: number, y: number): boolean => (raster.data[(y * raster.width + x) * 4] ?? 0) > 200;
      const left = 3 + 2; // terminal margin of 3 cells + the 2-column indent
      for (let x = left; x < left + matrix.length + 2 * quiet; x++) {
        expect(white(x, 2)).toBe(true); // first drawn text row (upper half)
      }
      for (let y = 2; y < 2 + quiet; y++) expect(white(left + 1, y)).toBe(true);
    }
  });

  it('draws modules square: half blocks pair two module rows per text row', () => {
    const matrix = qrMatrix(TELEGRAM);
    const side = matrix.length + 2 * 4;
    const lines = renderQr(matrix, 'color256').split('\n');
    expect(lines).toHaveLength(Math.ceil(side / 2));
    expect(frameSize(matrix.length, 'color256', 4)).toEqual({ columns: 2 + side, rows: Math.ceil(side / 2) });
  });
});

describe('negative control: the old qrcode-terminal `small: true` output', () => {
  const small = (payload: string): string => {
    let art = '';
    qrcodeTerminal.generate(payload, { small: true }, (text) => (art = text));
    return art;
  };

  it('is the plain-glyph picture that the old code printed (no colour codes at all)', () => {
    expect(small(WHATSAPP)).not.toContain('\u001b');
  });

  it('is inverted on a light terminal, so a decoder that never inverts fails', () => {
    expect(decode(rasterize(small(WHATSAPP), LIGHT))).toBeNull();
  });

  it('only works on an ideal dark theme (inverted on a light one) where explicit colours scan on both', () => {
    // Measured, not assumed: with ideal dark colours the old picture has the right polarity, so inversion alone
    // does not explain a dark terminal failing; it is inverted on light themes, has a 1-module quiet zone and no
    // bottom border for an odd module count, and its height (below) does not fit a default window.
    expect(decode(rasterize(small(WHATSAPP), DARK))).toBe(WHATSAPP);
    expect(decode(rasterize(small(WHATSAPP), LIGHT))).toBeNull();
    const explicit = [DARK, LIGHT].map((theme) => decode(rasterize(renderQr(WHATSAPP, 'color256', 4), theme)) === WHATSAPP);
    expect(explicit).toEqual([true, true]);
  });

  it('is taller than a default 24-row terminal for a WhatsApp payload, as is the new picture (hence the window-size check)', () => {
    expect(small(WHATSAPP).split('\n').length).toBeGreaterThan(24);
    expect(frameSize(qrMatrix(WHATSAPP).length, 'color256', 2).rows).toBeGreaterThan(24);
  });
});

describe('plain rendering (NO_COLOR / not a terminal)', () => {
  it('draws "##" for dark and blanks for light, with a quiet zone, and scans on a light theme', () => {
    const output = renderQr(WHATSAPP, 'plain', 4);
    expect(output).not.toContain('\u001b');
    expect(output).toContain('##');
    expect(output.split('\n')).toHaveLength(qrMatrix(WHATSAPP).length + 8);
    expect(decode(rasterize(output, LIGHT))).toBe(WHATSAPP);
    // A dark theme inverts it; only a decoder that also tries inverted codes still reads it.
    expect(decode(rasterize(output, DARK), true)).toBe(WHATSAPP);
  });

  it('picks the mode from the stream and the environment', () => {
    const tty = { isTTY: true, getColorDepth: () => 8 };
    expect(detectMode(tty, {})).toBe('color256');
    expect(detectMode({ isTTY: true, getColorDepth: () => 4 }, {})).toBe('color16');
    expect(detectMode({ isTTY: true, getColorDepth: () => 1 }, {})).toBe('plain');
    expect(detectMode(tty, { NO_COLOR: '1' })).toBe('plain');
    expect(detectMode(tty, { NO_COLOR: '' })).toBe('color256');
    expect(detectMode(tty, { TERM: 'dumb' })).toBe('plain');
    expect(detectMode({ isTTY: false, getColorDepth: () => 8 }, {})).toBe('plain');
    expect(detectMode({}, {})).toBe('plain');
  });
});

/** A fake terminal stream that records what is written to it. */
function fakeStream(options: { isTTY: boolean; columns?: number; rows?: number; depth?: number }): QrStream & {
  written: string[];
  resize(columns: number, rows: number): void;
} {
  const listeners = new Set<() => void>();
  const stream = {
    isTTY: options.isTTY,
    columns: options.columns,
    rows: options.rows,
    getColorDepth: () => options.depth ?? 8,
    written: [] as string[],
    write(text: string) {
      stream.written.push(text);
    },
    on(_event: 'resize', listener: () => void) {
      listeners.add(listener);
    },
    off(_event: 'resize', listener: () => void) {
      listeners.delete(listener);
    },
    resize(columns: number, rows: number) {
      stream.columns = columns;
      stream.rows = rows;
      for (const listener of [...listeners]) listener();
    },
  };
  return stream;
}

function screenOn(stream: QrStream, env: NodeJS.ProcessEnv = {}) {
  const logs: string[] = [];
  const screen = new QrScreen({ lang: 'en', write: (text) => logs.push(text), stream, env });
  return { screen, logs };
}

describe('QrScreen', () => {
  it('prints the colour code once, and scans when the window is big enough (with the larger quiet zone)', () => {
    const stream = fakeStream({ isTTY: true, columns: 120, rows: 60 });
    const { screen, logs } = screenOn(stream);
    screen.show(WHATSAPP);
    expect(logs).toHaveLength(1);
    expect(decode(rasterize(logs[0] ?? '', DARK))).toBe(WHATSAPP);
    expect(logs[0]?.split('\n')).toHaveLength(Math.ceil((qrMatrix(WHATSAPP).length + 8) / 2));
    expect(stream.written).toEqual([]);
  });

  it('falls back to the smaller quiet zone when only that fits, and never draws wider than the window', () => {
    const matrix = qrMatrix(WHATSAPP);
    const rows = frameSize(matrix.length, 'color256', 2).rows + 4;
    const stream = fakeStream({ isTTY: true, columns: matrix.length + 8, rows });
    const { screen, logs } = screenOn(stream);
    screen.show(WHATSAPP);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.split('\n')).toHaveLength(Math.ceil((matrix.length + 4) / 2));
    expect(decode(rasterize(logs[0] ?? '', DARK))).toBe(WHATSAPP);
  });

  it('prints an "enlarge the window / Cmd+minus" hint instead of a wrapped code when it does not fit', () => {
    const stream = fakeStream({ isTTY: true, columns: 80, rows: 24 });
    const { screen, logs } = screenOn(stream);
    screen.show(WHATSAPP);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain('\u2580');
    expect(logs[0]).toContain('Cmd+minus');
    expect(logs[0]).toMatch(/needs at least \d+ columns x \d+ rows; this window is 80 x 24/);
  });

  it('draws the code as soon as the window grows enough, once, and not while it is still too small', () => {
    const stream = fakeStream({ isTTY: true, columns: 80, rows: 24 });
    const { screen, logs } = screenOn(stream);
    screen.show(WHATSAPP);
    stream.resize(90, 30);
    expect(logs).toHaveLength(1); // still too small: no second hint, no code
    stream.resize(100, 60);
    expect(logs).toHaveLength(2);
    expect(decode(rasterize(logs[1] ?? '', DARK))).toBe(WHATSAPP);
    stream.resize(120, 80);
    expect(logs).toHaveLength(2); // the listener is gone once it has drawn
  });

  it('replaces the previous code on a terminal (cursor up + erase) and marks the new one', () => {
    const stream = fakeStream({ isTTY: true, columns: 120, rows: 60 });
    const { screen, logs } = screenOn(stream);
    screen.show(TELEGRAM);
    const rows = (logs[0] ?? '').split('\n').length;
    screen.show(TELEGRAM, 'New QR code (#2).');
    expect(stream.written).toEqual([`\u001b[${rows}A\u001b[0J`]);
    expect(logs[1]?.split('\n')[0]).toBe('New QR code (#2).');
    screen.clear();
    expect(stream.written).toHaveLength(2);
    expect(stream.written[1]).toBe(`\u001b[${rows + 1}A\u001b[0J`);
    screen.clear();
    expect(stream.written).toHaveLength(2); // nothing left to erase
  });

  it('never moves the cursor when the output is not a terminal; the marker line separates codes', () => {
    const stream = fakeStream({ isTTY: false });
    const { screen, logs } = screenOn(stream);
    screen.show(TELEGRAM);
    screen.show(TELEGRAM, 'New QR code (#2).');
    screen.clear();
    expect(stream.written).toEqual([]);
    expect(logs).toHaveLength(2);
    // Not a terminal = plain mode with the note, however large the code.
    expect(logs[0]).toContain('Plain-text QR code');
    expect(logs[0]).toContain('##');
  });

  it('uses plain mode, with the note, on a colour terminal when NO_COLOR is set', () => {
    const stream = fakeStream({ isTTY: true, columns: 400, rows: 200 });
    const { screen, logs } = screenOn(stream, { NO_COLOR: '1' });
    screen.show(TELEGRAM);
    expect(logs[0]).toContain('NO_COLOR');
    expect(logs[0]).toContain('##');
    expect(logs[0]).not.toContain('\u001b');
  });

  it('counts the rows a wrapped, wide-character line takes so the erase is exact', () => {
    expect(visualRows('abc', 80)).toBe(1);
    expect(visualRows('a'.repeat(81), 80)).toBe(2);
    expect(visualRows('한'.repeat(41), 80)).toBe(2); // each Hangul syllable is two columns wide
    expect(visualRows('x\ny\n\u001b[38;5;16mzz\u001b[0m', 80)).toBe(3);
    expect(visualRows('a'.repeat(500), Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('keeps every mode in sync with its frame size', () => {
    const matrix = qrMatrix(ZALO);
    for (const mode of ['color256', 'color16', 'plain'] as QrMode[]) {
      const lines = renderQr(matrix, mode, 4).split('\n');
      const size = frameSize(matrix.length, mode, 4);
      expect(lines).toHaveLength(size.rows);
      const visible = (line: string): number => line.replace(/\u001b\[[0-9;]*m/g, '').length;
      expect(Math.max(...lines.map(visible))).toBe(size.columns);
    }
  });
});

describe('qrWindowNeed: the window a login must have before a QR is started', () => {
  const modules = qrMatrix(WHATSAPP).length;
  const colour = { isTTY: true, getColorDepth: () => 8 };

  it('says a default 80x24 window is too small and names a bigger size', () => {
    const need = qrWindowNeed(modules, { ...colour, columns: 80, rows: 24 }, {});
    expect(need.fits).toBe(false);
    expect(need.rows).toBeGreaterThan(24);
  });

  it('fits exactly at the size it reports, and not one row or column below', () => {
    const need = qrWindowNeed(modules, { ...colour, columns: 80, rows: 24 }, {});
    expect(qrWindowNeed(modules, { ...colour, columns: need.columns, rows: need.rows }, {}).fits).toBe(true);
    expect(qrWindowNeed(modules, { ...colour, columns: need.columns - 1, rows: need.rows }, {}).fits).toBe(false);
    expect(qrWindowNeed(modules, { ...colour, columns: need.columns, rows: need.rows - 1 }, {}).fits).toBe(false);
  });

  it('plain output needs a bigger window than colour output', () => {
    const big = { ...colour, columns: 500, rows: 500 };
    const withColour = qrWindowNeed(modules, big, {});
    const plain = qrWindowNeed(modules, big, { NO_COLOR: '1' });
    expect(plain.columns).toBeGreaterThan(withColour.columns);
    expect(plain.rows).toBeGreaterThan(withColour.rows);
  });

  it('a stream that is not a terminal always fits: there is nothing to resize', () => {
    expect(qrWindowNeed(modules, { isTTY: false }, {}).fits).toBe(true);
    expect(qrWindowNeed(modules, {}, {}).fits).toBe(true);
  });

  it('a terminal that reports no size is treated as 80x24, not as unlimited', () => {
    expect(qrWindowNeed(modules, colour, {}).fits).toBe(false);
  });
});

describe('PHONE_APP_CHECKER_PLAIN', () => {
  it('forces the plain QR mode on a colour terminal; an empty value does not', () => {
    const tty = { isTTY: true, getColorDepth: () => 8 };
    expect(detectMode(tty, {})).toBe('color256');
    expect(detectMode(tty, { PHONE_APP_CHECKER_PLAIN: '1' })).toBe('plain');
    expect(detectMode(tty, { PHONE_APP_CHECKER_PLAIN: '' })).toBe('color256');
  });

  it('never moves the cursor on a terminal: a new code is printed below the old one', () => {
    const stream = fakeStream({ isTTY: true, columns: 400, rows: 200 });
    const { screen, logs } = screenOn(stream, { PHONE_APP_CHECKER_PLAIN: '1' });
    screen.show(TELEGRAM);
    screen.show(TELEGRAM, 'New QR code (#2).');
    screen.clear();
    expect(stream.written).toEqual([]);
    expect(logs).toHaveLength(2);
    expect(logs.join('')).not.toContain('\u001b');
  });
});
