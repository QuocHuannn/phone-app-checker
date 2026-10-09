/**
 * Small terminal UI toolkit: colours, icons, display width, truncation, wrapping, boxes and a spinner.
 *
 * Everything is gated by `Ui.rich`: true only on a real terminal (TTY) with a usable `TERM` and no `NO_COLOR`.
 * When it is false nothing here ever emits an ANSI escape sequence and icons fall back to plain ASCII, so
 * piped output and logs stay byte-for-byte what they were. Colours are limited to the standard 8-colour
 * palette plus bold / faint / inverse (no pure white, black or "bright black"), which stays legible on
 * both light and dark terminal themes.
 */

/** The part of a terminal stream the UI reads. */
export interface UiStream {
  isTTY?: boolean | undefined;
  columns?: number | undefined;
  rows?: number | undefined;
}

export interface Icons {
  ok: string;
  warn: string;
  fail: string;
  bullet: string;
  arrow: string;
  pointer: string;
  /** Ready / done (green) and "not set up / none" (dim): words always travel with them, never the icon alone. */
  ready: string;
  empty: string;
  /** A step that is running now (cyan) and one that is resting until a time (dim cyan). */
  working: string;
  waiting: string;
  ellipsis: string;
  /** Horizontal rule piece and the box corners / bar. */
  rule: string;
  topLeft: string;
  bottomLeft: string;
  bar: string;
  /** Spinner animation, one frame per tick. */
  spinner: readonly string[];
}

const UNICODE_ICONS: Icons = {
  ok: '✔',
  warn: '⚠',
  fail: '✖',
  bullet: '•',
  arrow: '›',
  pointer: '❯',
  ready: '✔',
  empty: '○',
  working: '●',
  waiting: '◷',
  ellipsis: '…',
  rule: '─',
  topLeft: '╭',
  bottomLeft: '╰',
  bar: '│',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
};

const ASCII_ICONS: Icons = {
  ok: '[ok]',
  warn: '[!]',
  fail: '[x]',
  bullet: '-',
  arrow: '>',
  pointer: '>',
  ready: '[ok]',
  empty: '[ ]',
  working: '*',
  waiting: '~',
  ellipsis: '...',
  rule: '-',
  topLeft: '+',
  bottomLeft: '+',
  bar: '|',
  spinner: ['|', '/', '-', '\\'],
};

export type Paint = (text: string) => string;

export interface Ui {
  /** ANSI output is allowed (terminal, usable TERM, no NO_COLOR). */
  readonly rich: boolean;
  /** Current window width in columns (re-read on every access; 80 when unknown). */
  readonly columns: number;
  readonly rows: number;
  readonly icons: Icons;
  bold: Paint;
  dim: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  cyan: Paint;
  /** Reverse video: the current line of a selection list, legible on any theme. */
  inverse: Paint;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const MIN_COLUMNS = 20;
const ESC = '\u001b';
/** Every CSI sequence (colours, cursor movement, erase). */
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Set (to anything but empty) to force the plain tier everywhere: no colour, no cursor movement,
 * no raw-key navigation — the accessible fallback for screen readers, braille displays and slow
 * terminals. Read by `isRich`, `detectMode` (qr.ts) and the QR screen's cursor handling.
 */
export const PLAIN_ENV = 'PHONE_APP_CHECKER_PLAIN';

/** True when the plain tier is forced (see {@link PLAIN_ENV}). */
export function plainForced(env: NodeJS.ProcessEnv): boolean {
  return (env[PLAIN_ENV] ?? '') !== '';
}

/**
 * Whether ANSI escape sequences may be written to `stream`: it is a terminal, `TERM` names one that
 * understands them (not unset, not "dumb"), `NO_COLOR` is not set (to anything but empty, no-color.org)
 * and the plain tier is not forced with {@link PLAIN_ENV}.
 */
export function isRich(stream: UiStream, env: NodeJS.ProcessEnv): boolean {
  if (plainForced(env)) return false;
  if (stream.isTTY !== true) return false;
  const term = env.TERM?.trim().toLowerCase();
  if (term === undefined || term === '' || term === 'dumb') return false;
  const noColor = env.NO_COLOR;
  return noColor === undefined || noColor === '';
}

/** A `Ui` for one stream; width and height are read from the stream each time they are asked for. */
export function createUi(stream: UiStream, env: NodeJS.ProcessEnv): Ui {
  const rich = isRich(stream, env);
  const style = (open: number, close: number): Paint =>
    rich ? (text) => `${ESC}[${open}m${text}${ESC}[${close}m` : (text) => text;
  return {
    rich,
    get columns() {
      const columns = stream.columns;
      return typeof columns === 'number' && Number.isFinite(columns) && columns > 0 ? Math.max(MIN_COLUMNS, Math.floor(columns)) : DEFAULT_COLUMNS;
    },
    get rows() {
      const rows = stream.rows;
      return typeof rows === 'number' && Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : DEFAULT_ROWS;
    },
    icons: rich ? UNICODE_ICONS : ASCII_ICONS,
    bold: style(1, 22),
    dim: style(2, 22),
    red: style(31, 39),
    green: style(32, 39),
    yellow: style(33, 39),
    cyan: style(36, 39),
    inverse: style(7, 27),
  };
}

/** The UI of a stream that is not a terminal: no ANSI, ASCII icons. */
export const PLAIN_UI: Ui = createUi({}, {});

/** `text` without ANSI escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;
const ZERO_WIDTH = /^[\p{M}\u200b-\u200f\u2060\ufe00-\ufe0f]$/u;

/** Terminal columns one code point takes: 0 for combining / joiner marks, 2 for CJK, Hangul, full-width and emoji, else 1. */
export function charWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x20 || (code >= 0x7f && code < 0xa0)) return 0;
  if (code < 0x300) return 1;
  if (ZERO_WIDTH.test(char)) return 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    EMOJI_PRESENTATION.test(char);
  return wide ? 2 : 1;
}

/** Terminal columns `text` takes (escape sequences take none). */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) width += charWidth(char);
  return width;
}

/** Split `text` into atoms: whole ANSI sequences (zero width) and single code points. */
function atoms(text: string): { text: string; width: number; ansi: boolean }[] {
  const out: { text: string; width: number; ansi: boolean }[] = [];
  let last = 0;
  for (const match of text.matchAll(ANSI)) {
    for (const char of text.slice(last, match.index)) out.push({ text: char, width: charWidth(char), ansi: false });
    out.push({ text: match[0], width: 0, ansi: true });
    last = match.index + match[0].length;
  }
  for (const char of text.slice(last)) out.push({ text: char, width: charWidth(char), ansi: false });
  return out;
}

/**
 * Cut `text` to at most `max` columns, ending in `ellipsis` when something was cut. Colour codes are kept
 * (and reset when the cut falls inside a coloured span); a wide character is never split.
 */
export function truncate(text: string, max: number, ellipsis = '…'): string {
  if (displayWidth(text) <= max) return text;
  const room = Math.max(0, max - displayWidth(ellipsis));
  let width = 0;
  let out = '';
  let styled = false;
  for (const atom of atoms(text)) {
    if (atom.ansi) {
      out += atom.text;
      styled = true;
      continue;
    }
    if (width + atom.width > room) break;
    out += atom.text;
    width += atom.width;
  }
  return `${out}${styled ? `${ESC}[0m` : ''}${ellipsis}`;
}

/**
 * A path cut to `max` columns from the left, so the file name (the part that matters) survives:
 * `…/Downloads/customers/report.csv`. Cuts at a folder boundary when one fits.
 */
export function truncatePath(path: string, max: number, ellipsis = '…'): string {
  if (displayWidth(path) <= max) return path;
  const room = Math.max(1, max - displayWidth(ellipsis));
  const chars = Array.from(path);
  let width = 0;
  let start = chars.length;
  while (start > 0 && width + charWidth(chars[start - 1] as string) <= room) {
    start -= 1;
    width += charWidth(chars[start] as string);
  }
  let tail = chars.slice(start);
  const slash = tail.indexOf('/');
  if (slash > 0 && slash < tail.length - 1) tail = tail.slice(slash);
  return `${ellipsis}${tail.join('')}`;
}

/** One paragraph (no line breaks) cut into lines of at most `limit` columns. */
function wrapParagraph(paragraph: string, limit: number): string[] {
  const lines: string[] = [];
  let lineWidth = 0;
  let lastSpace = -1; // index in `cells` of the last space
  let cells: string[] = [];
  const flush = (upTo: number): void => {
    lines.push(cells.slice(0, upTo).join('').trimEnd());
    cells = cells.slice(upTo).filter((cell, index) => !(index === 0 && cell === ' '));
    lineWidth = cells.reduce((sum, cell) => sum + displayWidth(cell), 0);
    lastSpace = cells.lastIndexOf(' ');
  };
  for (const atom of atoms(paragraph)) {
    if (!atom.ansi && lineWidth + atom.width > limit) {
      // A space that does not fit is the break itself: the word before it stays whole on this line.
      if (atom.text === ' ') {
        flush(cells.length);
        continue;
      }
      if (lastSpace > 0) flush(lastSpace);
      else flush(cells.length);
    }
    cells.push(atom.text);
    lineWidth += atom.width;
    if (atom.text === ' ') lastSpace = cells.length - 1;
  }
  lines.push(cells.join('').trimEnd());
  return lines;
}

/**
 * Break `text` into lines of at most `width` columns, at spaces when possible and anywhere otherwise
 * (CJK text has no spaces). Existing line breaks are kept, and so is a paragraph's leading indent (a hanging
 * indent: every wrapped line of `  1) Open ...` starts with the same two blanks). Escape sequences are carried along unbroken.
 */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    const indent = /^ */.exec(paragraph)?.[0] ?? '';
    const limit = Math.max(4, width - indent.length);
    for (const part of wrapParagraph(paragraph.slice(indent.length), limit)) lines.push(part === '' ? '' : `${indent}${part}`);
  }
  return lines;
}

/** Language-neutral duration: `42 s`, `5 min`, `1 h 05 min`. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/**
 * A clock time in local time, `HH:MM` when it falls on the same local calendar day as `now`
 * (default: the real current time), `DD Mon HH:MM` otherwise — so a resume tomorrow or next week
 * is never ambiguous. Replaces `toISOString()` in user-visible text, which was always UTC.
 */
export function formatLocalTime(ms: number, now?: number): string {
  const at = new Date(ms);
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const ref = new Date(now ?? Date.now());
  const sameDay =
    at.getFullYear() === ref.getFullYear() && at.getMonth() === ref.getMonth() && at.getDate() === ref.getDate();
  return sameDay ? time : `${pad(at.getDate())} ${MONTH_NAMES[at.getMonth()]} ${time}`;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export type Tone = 'info' | 'ok' | 'warn' | 'error';

export interface BoxLine {
  text: string;
  paint?: Paint;
}

/** Widest a box is drawn, however big the window. */
const BOX_MAX = 72;

/**
 * A framed block: a titled top rule, lines marked with a bar and a bottom rule. There is deliberately no right edge, so mixed-width text
 * (CJK, Hangul, emoji) can never push a border out of line. Lines are wrapped to the window; `tone` colours the frame.
 */
export function box(ui: Ui, title: string, lines: readonly (string | BoxLine)[], tone: Tone = 'info'): string[] {
  const frame: Paint = { info: ui.cyan, ok: ui.green, warn: ui.yellow, error: ui.red }[tone];
  const total = Math.max(MIN_COLUMNS, Math.min(ui.columns - 1, BOX_MAX));
  const { icons } = ui;
  const heading = truncate(title, total - 6, icons.ellipsis);
  const top = `${icons.topLeft}${icons.rule} ${heading} ${icons.rule.repeat(Math.max(1, total - displayWidth(heading) - 4))}`;
  const out = [frame(ui.bold(top))];
  for (const entry of lines) {
    const { text, paint } = typeof entry === 'string' ? { text: entry, paint: undefined } : entry;
    for (const part of wrap(text, total - 2)) out.push(`${frame(icons.bar)} ${paint === undefined ? part : paint(part)}`);
  }
  out.push(frame(`${icons.bottomLeft}${icons.rule.repeat(total - 1)}`));
  return out;
}

/** Items joined by ` · `, wrapped to the window, for the status strip of the banner. */
export function strip(ui: Ui, items: readonly string[], separator = ' · '): string[] {
  const lines: string[] = [];
  let current = '';
  const max = Math.min(ui.columns - 4, BOX_MAX - 2);
  for (const item of items) {
    const next = current === '' ? item : `${current}${separator}${item}`;
    if (current !== '' && displayWidth(next) > max) {
      lines.push(current);
      current = item;
    } else {
      current = next;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** The sink a spinner or progress bar draws on. */
export interface DrawStream {
  write(text: string): unknown;
}

/**
 * An animated one-line "waiting" indicator on a line of its own: it is redrawn by moving up one line, so anything else
 * printed meanwhile (an interrupt notice, a log line) lands below it instead of being glued to it. On a stream that is
 * not a rich terminal it writes nothing at all (never on a pipe or a log). `stop()` erases the line and is safe to call
 * any number of times.
 */
export class Spinner {
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private text: string;
  private active = false;
  private readonly stream: DrawStream;
  private readonly ui: Ui;
  private readonly intervalMs: number;

  constructor(stream: DrawStream, ui: Ui, text: string, intervalMs = 100) {
    this.stream = stream;
    this.ui = ui;
    this.text = text;
    this.intervalMs = intervalMs;
  }

  start(): this {
    if (!this.ui.rich || this.active) return this;
    this.active = true;
    this.draw(false);
    this.timer = setInterval(() => this.draw(true), this.intervalMs);
    this.timer.unref();
    return this;
  }

  update(text: string): void {
    this.text = text;
    if (this.active) this.draw(true);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    clearInterval(this.timer);
    this.timer = undefined;
    this.stream.write(CURSOR.upAndClear(1));
  }

  private draw(redraw: boolean): void {
    const frames = this.ui.icons.spinner;
    const glyph = frames[this.frame % frames.length] as string;
    this.frame += 1;
    const line = truncate(`${glyph} ${this.text}`, this.ui.columns - 1, this.ui.icons.ellipsis);
    this.stream.write(`${redraw ? `${ESC}[1A\r${ESC}[2K` : ''}${this.ui.cyan(line)}\n`);
  }
}

/** ANSI sequences other modules write directly (always guarded by `Ui.rich`). */
export const CURSOR = {
  hide: `${ESC}[?25l`,
  show: `${ESC}[?25h`,
  /** Erase the current line and return to column 0. */
  clearLine: `\r${ESC}[2K`,
  /** Move up `rows` lines to column 0 and erase from there to the end of the screen. */
  upAndClear: (rows: number): string => `${rows > 0 ? `${ESC}[${rows}A` : ''}\r${ESC}[J`,
} as const;
