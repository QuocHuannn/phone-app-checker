import { charWidth } from '../../src/ui.ts';

/**
 * What a terminal would show: feed the bytes the UI writes, read the grid back. The tests can then
 * assert on the picture the user sees instead of on raw escape bytes.
 *
 * Emulates exactly the repertoire `src/` emits (verified by grepping for `\u001b`):
 *
 * - `\n` (next row, scrolling at the bottom) and `\r` (column 0);
 * - `ESC[nA`/`ESC[nB`/`ESC[nC`/`ESC[nD` relative moves and `ESC[nG` / `ESC[row;colH` / `ESC[H`
 *   absolute positioning (the last two are emitted by Node's readline, not by `src/`);
 * - `ESC[J`/`ESC[0J`/`ESC[1J`/`ESC[2J` erase in display and `ESC[K`/`ESC[1K`/`ESC[2K` erase in line;
 * - SGR `ESC[...m` and private modes `ESC[?25l`/`ESC[?25h`: parsed and ignored (the grid holds plain
 *   characters — a "green row" assertion is impossible by design);
 * - other CSI finals (`ESC[?...h/l` included): parsed and ignored.
 *
 * Autowrap follows the pending-wrap rule real terminals use: a character that fills the last column
 * sets a flag and the *next* printable character wraps (and scrolls at the bottom of the screen) —
 * so a line of exactly `columns` cells followed by `\n` does not leave a stray blank row. Cell
 * widths come from `charWidth` in `src/ui.ts`: wide glyphs occupy two cells (the second is a
 * continuation cell), combining marks join the cell to their left.
 *
 * Intentionally not handled (nothing in `src/` emits them): `ESC]...` OSC strings and other non-CSI
 * sequences (`ESC c`, `ESC 7`, `ESC O A`, …) have only their introducer bytes skipped — their
 * payload would land as text, but nothing emits one — plus tabs, backspace, insert/delete, and
 * partial scroll regions. An incomplete escape sequence at the end of a `feed` chunk is buffered
 * for the next call.
 */
export interface ScreenGrid {
  /** Feed more bytes written by the UI (may be called repeatedly). */
  feed(text: string): void;
  /** The grid as the user sees it: `rows` strings (trailing blanks trimmed), each at most `columns` wide. */
  text(): string[];
  /** All rows joined by `\n`; for `toContain`-style assertions. */
  snapshot(): string;
  /** Cursor cell (0-based; after a wrap-pending the last cell of the row is reported). */
  cursor(): { row: number; col: number };
}

const CSI = /^\u001b\[([0-?]*)([ -/]*)([@-~])/;
const BLANK = ' ';

/** A `columns` × `rows` character grid with a cursor; see the module comment for the repertoire. */
export function screenGrid(options: { columns: number; rows: number }): ScreenGrid {
  const columns = Math.max(1, Math.floor(options.columns));
  const rowCount = Math.max(1, Math.floor(options.rows));
  const grid: string[][] = [];
  /** `cont[r][c]` marks `c` as the second cell of the wide character in `c - 1`. */
  const cont: boolean[][] = [];
  let row = 0;
  let col = 0;
  /** Set when the previous character filled the last column: the next one wraps first. */
  let wrapPending = false;
  /** Bytes of an escape sequence split across two `feed` calls. */
  let held = '';

  const cells = (r: number): string[] => (grid[r] ??= Array<string>(columns).fill(BLANK));
  const pairs = (r: number): boolean[] => (cont[r] ??= Array<boolean>(columns).fill(false));

  const scroll = (): void => {
    grid.shift();
    cont.shift();
    grid.push(Array<string>(columns).fill(BLANK));
    cont.push(Array<boolean>(columns).fill(false));
  };

  const newline = (): void => {
    wrapPending = false;
    col = 0;
    if (row === rowCount - 1) scroll();
    else row += 1;
  };

  /** Blank `cells(r)[from..to]`, dissolving any wide pair that touches the range. */
  const eraseCells = (r: number, from: number, to: number): void => {
    const line = cells(r);
    const pair = pairs(r);
    for (let c = from; c <= to && c < columns; c += 1) {
      if (pair[c] === true && c - 1 >= 0) {
        pair[c] = false;
        line[c - 1] = BLANK;
      }
      line[c] = BLANK;
      // The pair may continue one cell past `to`; clear its other half too.
      if (pair[c + 1] === true) pair[c + 1] = false;
    }
  };

  const eraseLine = (mode: number): void => {
    if (mode === 0) eraseCells(row, Math.min(col, columns - 1), columns - 1);
    else if (mode === 1) eraseCells(row, 0, Math.min(col, columns - 1));
    else eraseCells(row, 0, columns - 1);
  };

  const eraseScreen = (mode: number): void => {
    if (mode === 0) {
      eraseLine(0);
      for (let r = row + 1; r < rowCount; r += 1) eraseCells(r, 0, columns - 1);
    } else if (mode === 1) {
      for (let r = 0; r < row; r += 1) eraseCells(r, 0, columns - 1);
      eraseLine(1);
    } else {
      for (let r = 0; r < rowCount; r += 1) eraseCells(r, 0, columns - 1);
    }
  };

  const putChar = (char: string): void => {
    const width = charWidth(char);
    if (width === 0) {
      // Combining mark / zero-width: join the cell just written, else the cell under the cursor.
      const target = wrapPending ? columns - 1 : Math.max(0, col - 1);
      if (pairs(row)[target] === true) eraseCells(row, target - 1, target);
      const line = cells(row);
      line[target] = (line[target] ?? '') + char;
      return;
    }
    if (wrapPending) {
      // A wide glyph that does not fit lands on the next row; the last column stays blank.
      newline();
    }
    if (col + width > columns) newline();
    const line = cells(row);
    // Overwriting half of a wide glyph erases the whole glyph.
    if (pairs(row)[col] === true && col - 1 >= 0) {
      pairs(row)[col] = false;
      line[col - 1] = BLANK;
    }
    line[col] = char;
    if (width === 2) {
      line[col + 1] = BLANK;
      pairs(row)[col + 1] = true;
    }
    col += width;
    if (col >= columns) wrapPending = true;
  };

  /** `params` like `"5"` or `"3;7"` as numbers; `""`/`"0"` count as 0 so callers can apply defaults. */
  const numeric = (params: string, index: number): number => {
    const part = params.split(';')[index] ?? '';
    return part === '' ? 0 : Math.max(0, Number.parseInt(part, 10) || 0);
  };

  const csi = (params: string, final: string): void => {
    const n = Math.max(1, numeric(params, 0));
    switch (final) {
      case 'A': row = Math.max(0, row - n); wrapPending = false; break;
      case 'B': row = Math.min(rowCount - 1, row + n); wrapPending = false; break;
      case 'C': col = Math.min(columns - 1, Math.min(col, columns - 1) + n); wrapPending = false; break;
      case 'D': col = Math.max(0, Math.min(col, columns - 1) - n); wrapPending = false; break;
      case 'E': row = Math.min(rowCount - 1, row + n); col = 0; wrapPending = false; break;
      case 'F': row = Math.max(0, row - n); col = 0; wrapPending = false; break;
      case 'G': case '`': col = Math.min(columns - 1, Math.max(0, n - 1)); wrapPending = false; break;
      case 'H': case 'f': {
        row = Math.min(rowCount - 1, Math.max(0, Math.max(1, numeric(params, 0)) - 1));
        col = Math.min(columns - 1, Math.max(0, Math.max(1, numeric(params, 1)) - 1));
        wrapPending = false;
        break;
      }
      case 'J': eraseScreen(numeric(params, 0)); break;
      case 'K': eraseLine(numeric(params, 0)); break;
      default:
        // SGR 'm', private '?25l/h' set/reset and anything else: no effect on the grid.
        break;
    }
  };

  /** Non-CSI escape (e.g. `ESC O A`, `ESC c`, `ESC ]...`): nothing `src/` emits needs it. */
  const skipEscape = (text: string, i: number): number => {
    const next = text[i + 1];
    if (next === undefined) return i + 1;
    if (next === 'O') return i + 3; // SS3: two more bytes
    return i + 1 + next.length;
  };

  const feed = (text: string): void => {
    const input = held + text;
    held = '';
    let i = 0;
    while (i < input.length) {
      const char = String.fromCodePoint(input.codePointAt(i) as number);
      if (char === '\u001b') {
        const match = CSI.exec(input.slice(i));
        if (match !== null) {
          csi(match[1] as string, match[3] as string);
          i += match[0].length;
        } else if (input.startsWith('\u001b[', i)) {
          // Incomplete CSI: wait for the rest — unless a byte outside the CSI grammar already
          // aborted it (a stray `ESC[` must not swallow real text forever).
          const aborted = [...input.slice(i + 2)].some((c) => {
            const code = c.codePointAt(0) as number;
            return code < 0x20 || code > 0x7e;
          });
          if (aborted) i += 2;
          else {
            held = input.slice(i);
            return;
          }
        } else if (i + 1 >= input.length) {
          held = input.slice(i); // lone ESC at a chunk boundary
          return;
        } else {
          i += skipEscape(input, i);
        }
        continue;
      }
      if (char === '\n') newline();
      else if (char === '\r') { col = 0; wrapPending = false; }
      else putChar(char);
      i += char.length;
    }
  };

  const text = (): string[] => {
    const lines: string[] = [];
    for (let r = 0; r < rowCount; r += 1) lines.push((grid[r] ?? []).join('').trimEnd());
    return lines;
  };

  return {
    feed,
    text,
    snapshot: () => text().join('\n'),
    cursor: () => ({ row, col: Math.min(col, columns - 1) }),
  };
}
