import QRCode from 'qrcode-terminal/vendor/QRCode/index.js';
import QRErrorCorrectLevel from 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel.js';
import { DEFAULT_LANG, translate, type Lang } from './i18n/index.ts';
import { createUi, truncate } from './ui.ts';

/**
 * Terminal QR codes that scan on any theme.
 *
 * A QR code printed with the terminal's own foreground/background colours is only readable when the
 * theme happens to match what the encoder assumed: on a dark theme the quiet zone vanishes into the
 * background and light themes invert the code. Here every module is drawn with explicit, absolute
 * colours (pure black on pure white, white quiet zone included), so the picture is the same on every
 * theme. Where colours cannot be used (NO_COLOR, no terminal, dumb terminals) a plain `##` / blank
 * rendering is produced and the user is told how to read it. A code that does not fit in the window is
 * never drawn wrapped or cut: the user is asked to enlarge the window and it is drawn once it fits.
 */

/** Blank modules around the code. The QR standard asks for 4; 2 is the smallest that phones read reliably. */
const QUIET_PREFERRED = 4;
const QUIET_MINIMUM = 2;
/** Columns kept free left of the code. */
const INDENT = 2;
/** Terminal rows kept for the instructions above the code and the prompt below it. */
const RESERVED_ROWS = 4;
const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

export type QrMode = 'color256' | 'color16' | 'plain';

/** The part of a terminal stream the renderer reads; `process.stderr` (where login output goes) by default. */
export interface QrStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  getColorDepth?: (env?: NodeJS.ProcessEnv) => number;
  write(text: string): unknown;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

/** Error-correction level L: the smallest code that still scans from a screen. */
export function qrMatrix(payload: string): boolean[][] {
  const code = new QRCode(-1, QRErrorCorrectLevel.L);
  code.addData(payload);
  code.make();
  return code.modules.map((row) => [...row]);
}

/** How to draw on `stream`: with explicit colours when it is a colour terminal, else plain text. */
export function detectMode(stream: Pick<QrStream, 'isTTY' | 'getColorDepth'>, env: NodeJS.ProcessEnv): QrMode {
  if (stream.isTTY !== true) return 'plain';
  if ((env.NO_COLOR ?? '') !== '' || env.TERM === 'dumb') return 'plain';
  const depth = stream.getColorDepth?.(env) ?? 1;
  if (depth >= 8) return 'color256';
  if (depth >= 4) return 'color16';
  return 'plain';
}

/** Width and height in terminal cells of the code drawn in `mode` with `quiet` blank modules around it. */
export function frameSize(modules: number, mode: QrMode, quiet: number): { columns: number; rows: number } {
  const side = modules + 2 * quiet;
  return mode === 'plain' ? { columns: INDENT + 2 * side, rows: side } : { columns: INDENT + side, rows: Math.ceil(side / 2) };
}

const RESET = '\u001b[0m';
/** Pure black and pure white in the xterm 256-colour palette (16 and 231), and in the 16-colour one. */
const PALETTE = {
  color256: { darkFg: '38;5;16', lightFg: '38;5;231', darkBg: '48;5;16', lightBg: '48;5;231' },
  color16: { darkFg: '30', lightFg: '97', darkBg: '40', lightBg: '107' },
} as const;

/** The code as text lines, quiet zone included, no trailing newline. */
function drawLines(matrix: boolean[][], mode: QrMode, quiet: number): string[] {
  const modules = matrix.length;
  const side = modules + 2 * quiet;
  const dark = (row: number, column: number): boolean => matrix[row - quiet]?.[column - quiet] === true;
  const indent = ' '.repeat(INDENT);
  const lines: string[] = [];

  if (mode === 'plain') {
    for (let row = 0; row < side; row++) {
      let line = indent;
      for (let column = 0; column < side; column++) line += dark(row, column) ? '##' : '  ';
      lines.push(line);
    }
    return lines;
  }

  const colors = PALETTE[mode];
  // Two module rows per text row: the upper half block in the foreground colour, the lower half is the
  // background. An odd count gets one more (white) row so the last text row is complete.
  for (let row = 0; row < side; row += 2) {
    let line = indent;
    let current = '';
    for (let column = 0; column < side; column++) {
      const upper = dark(row, column);
      const lower = row + 1 < side && dark(row + 1, column);
      const style = `\u001b[${upper ? colors.darkFg : colors.lightFg};${lower ? colors.darkBg : colors.lightBg}m`;
      if (style !== current) {
        line += style;
        current = style;
      }
      line += '\u2580';
    }
    lines.push(line + RESET);
  }
  return lines;
}

/** Render the code for a string, without any window-size decision. */
export function renderQr(payload: string | boolean[][], mode: QrMode, quiet = QUIET_PREFERRED): string {
  const matrix = typeof payload === 'string' ? qrMatrix(payload) : payload;
  return drawLines(matrix, mode, quiet).join('\n');
}

/** Terminal columns a character takes: 2 for wide (CJK, Hangul, full-width) characters, else 1. */
function cellWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6);
  return wide ? 2 : 1;
}

/** Terminal rows `text` takes once long lines wrap at `columns` (colour codes take no space; infinite columns = never wrap). */
export function visualRows(text: string, columns: number): number {
  let rows = 0;
  for (const line of text.split('\n')) {
    let width = 0;
    for (const char of line.replace(/\u001b\[[0-9;]*m/g, '')) width += cellWidth(char);
    rows += Number.isFinite(columns) ? Math.max(1, Math.ceil(width / columns)) : 1;
  }
  return rows;
}

interface Layout {
  matrix: boolean[][];
  mode: QrMode;
  /** Blank modules around the code, or `undefined` when the window is too small for it. */
  quiet: number | undefined;
  /** Lines above the code (heading and, in plain mode, the note). */
  above: string[];
  /** Terminal rows those lines take. */
  aboveRows: number;
  /** Window size; infinite when the output is not a terminal. */
  columns: number;
  rows: number;
}

/**
 * The code on the user's screen: draws it, replaces it when the service rotates it, and removes it when
 * login is over. `write` prints one block of text followed by a newline (a `ctx.log`); cursor movement
 * (erasing the previous code) is written to the stream directly and only when it is a terminal.
 */
export class QrScreen {
  private readonly lang: Lang;
  private readonly write: (text: string) => void;
  private readonly stream: QrStream;
  private readonly env: NodeJS.ProcessEnv;
  /** Terminal rows of the block printed last (the code or the "enlarge the window" hint), while it is still the last thing on screen. */
  private shownRows: number | undefined;
  private pending: { source: string | boolean[][]; heading: string | undefined } | undefined;
  private onResize: (() => void) | undefined;
  /** Text of the animated "waiting" line under the code (terminals with colour only), and its timer. */
  private readonly waiting: string | undefined;
  private waitTimer: NodeJS.Timeout | undefined;
  private waitFrame = 0;

  constructor(options: { lang?: Lang; write: (text: string) => void; stream?: QrStream; env?: NodeJS.ProcessEnv; waiting?: string }) {
    this.lang = options.lang ?? DEFAULT_LANG;
    this.write = options.write;
    this.stream = options.stream ?? process.stderr;
    this.env = options.env ?? process.env;
    this.waiting = options.waiting;
  }

  /** Draw `source` (a payload to encode, or finished modules), replacing the code drawn before. `heading` goes above it. */
  show(source: string | boolean[][], heading?: string): void {
    this.erase();
    this.draw(source, heading, this.layout(source, heading));
  }

  /** Remove the code (or the "enlarge the window" hint) from a terminal; on other outputs it stays in the log. */
  clear(): void {
    this.pending = undefined;
    this.unlisten();
    this.erase();
  }

  private layout(source: string | boolean[][], heading: string | undefined): Layout {
    const matrix = typeof source === 'string' ? qrMatrix(source) : source;
    const mode = detectMode(this.stream, this.env);
    const terminal = this.stream.isTTY === true;
    const columns = terminal ? (this.stream.columns ?? DEFAULT_COLUMNS) : Number.POSITIVE_INFINITY;
    const rows = terminal ? (this.stream.rows ?? DEFAULT_ROWS) : Number.POSITIVE_INFINITY;
    const above = [...(heading === undefined ? [] : [heading]), ...(mode === 'plain' ? [translate(this.lang, 'qrPlainNote')] : [])];
    const aboveRows = above.length === 0 ? 0 : visualRows(above.join('\n'), columns);
    const fits = (quiet: number): boolean => {
      const size = frameSize(matrix.length, mode, quiet);
      // The width must stay below the window width: a full last column wraps in some terminals.
      return size.columns < columns && size.rows + aboveRows + RESERVED_ROWS <= rows;
    };
    return { matrix, mode, quiet: [QUIET_PREFERRED, QUIET_MINIMUM].find(fits), above, aboveRows, columns, rows };
  }

  private draw(source: string | boolean[][], heading: string | undefined, layout: Layout): void {
    const { matrix, mode, quiet, above, aboveRows, columns, rows } = layout;
    if (quiet === undefined) {
      const need = frameSize(matrix.length, mode, QUIET_MINIMUM);
      const hint = translate(this.lang, 'qrTooBig', {
        needColumns: need.columns + 1,
        needRows: need.rows + aboveRows + RESERVED_ROWS,
        haveColumns: Number.isFinite(columns) ? columns : 0,
        haveRows: Number.isFinite(rows) ? rows : 0,
      });
      this.print(heading === undefined ? [hint] : [heading, hint], columns);
      this.pending = { source, heading };
      this.listen();
      return;
    }
    this.pending = undefined;
    this.unlisten();
    this.print([...above, ...drawLines(matrix, mode, quiet)], columns);
    this.startWaiting();
  }

  private print(lines: string[], columns: number): void {
    const text = lines.join('\n');
    this.write(text);
    this.shownRows = visualRows(text, columns);
  }

  /** One animated line under the code ("Waiting for you to scan the code..."), counted as part of the block so `erase` removes it. */
  private startWaiting(): void {
    const text = this.waiting;
    if (text === undefined || this.stream.isTTY !== true) return;
    const ui = createUi(this.stream, this.env);
    if (!ui.rich) return;
    const frames = ui.icons.spinner;
    const line = (): string => ui.cyan(truncate(`${frames[this.waitFrame++ % frames.length] as string} ${text}`, ui.columns - 1, ui.icons.ellipsis));
    this.stream.write(`${line()}\n`);
    this.shownRows = (this.shownRows ?? 0) + 1;
    this.waitTimer = setInterval(() => this.stream.write(`\u001b[1A\r\u001b[2K${line()}\n`), 120);
    this.waitTimer.unref();
  }

  private erase(): void {
    clearInterval(this.waitTimer);
    this.waitTimer = undefined;
    const rows = this.shownRows;
    this.shownRows = undefined;
    if (rows === undefined || this.stream.isTTY !== true) return;
    this.stream.write(`\u001b[${rows}A\u001b[0J`);
  }

  /** Draw the code as soon as the window has grown enough for it (checked on every resize, drawn once). */
  private listen(): void {
    if (this.onResize !== undefined || this.stream.on === undefined) return;
    this.onResize = () => {
      const pending = this.pending;
      if (pending === undefined) return;
      const layout = this.layout(pending.source, pending.heading);
      if (layout.quiet === undefined) return;
      // The hint stays on screen: the window changed size, so how many rows it now takes is unknown.
      this.shownRows = undefined;
      this.draw(pending.source, pending.heading, layout);
    };
    this.stream.on('resize', this.onResize);
  }

  private unlisten(): void {
    if (this.onResize === undefined) return;
    this.stream.off?.('resize', this.onResize);
    this.onResize = undefined;
  }
}
