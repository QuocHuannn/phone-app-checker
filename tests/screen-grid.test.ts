import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgressRenderer, type ProgressEvent } from '../src/progress.ts';
import { selectMenu, type SelectItem } from '../src/select.ts';
import { createUi, displayWidth, Spinner } from '../src/ui.ts';
import { fakeProcess, fakeTty } from './helpers/fake-tty.ts';
import { screenGrid, type ScreenGrid } from './helpers/screen-grid.ts';

const ESC = '\u001b';
const RICH_ENV = { TERM: 'xterm-256color' };
const HINT = '↑↓ move · Enter select · q quit';
const ITEMS: SelectItem<string>[] = [
  { value: 'check', label: 'Check a CSV file', key: '1' },
  { value: 'login', label: 'Log in an app account', key: '2' },
  { value: 'lang', label: 'Language', key: 'L' },
  { value: 'quit', label: 'Quit', key: '0' },
];

afterEach(() => {
  vi.useRealTimers();
});

/** The rows holding at least one visible character. */
const nonBlank = (grid: ScreenGrid): string[] => grid.text().filter((line) => line.trim() !== '');

/** Runs `selectMenu` over a fake terminal whose output the returned grid mirrors. */
function openMenu<V>(options: { columns?: number; rows?: number; items?: SelectItem<V>[] } = {}) {
  const columns = options.columns ?? 80;
  const rows = options.rows ?? 24;
  const tty = fakeTty({ columns, rows });
  const ui = createUi(tty.io.output as never, RICH_ENV);
  const grid = screenGrid({ columns, rows });
  let seen = 0;
  /** Push only the bytes written since the last call into the grid (like a real terminal). */
  const pump = () => {
    const screen = tty.screen();
    grid.feed(screen.slice(seen));
    seen = screen.length;
  };
  const start = () => {
    const items = (options.items ?? ITEMS) as SelectItem<V>[];
    const pending = selectMenu(tty.io, ui, { title: 'Main menu', items, hint: HINT }, fakeProcess());
    pending.catch(() => undefined); // rejections are asserted by the tests that cause them
    return pending;
  };
  return { tty, ui, grid, pump, start };
}

describe('screenGrid: plain text, colours and cursor keys', () => {
  it('lays text on rows and reports the cursor', () => {
    const grid = screenGrid({ columns: 20, rows: 3 });
    grid.feed('hello\nworld');
    expect(grid.text()).toEqual(['hello', 'world', '']);
    expect(grid.cursor()).toEqual({ row: 1, col: 5 });
    expect(grid.snapshot()).toBe('hello\nworld\n');
  });

  it('ignores SGR colours and private modes for the text content', () => {
    const grid = screenGrid({ columns: 20, rows: 3 });
    grid.feed(`${ESC}[36m${ESC}[1mcyan bold${ESC}[39m${ESC}[22m${ESC}[?25l plain${ESC}[?25h`);
    expect(grid.text()[0]).toBe('cyan bold plain');
  });

  it('moves the cursor relative and absolute, clamped to the grid', () => {
    const grid = screenGrid({ columns: 10, rows: 4 });
    grid.feed('abc\ndef\nghi');
    grid.feed(`${ESC}[2A`); // back to row 0, still on 'c'
    expect(grid.cursor()).toEqual({ row: 0, col: 3 });
    grid.feed(`${ESC}[B${ESC}[1D`);
    expect(grid.cursor()).toEqual({ row: 1, col: 2 });
    grid.feed(`${ESC}[7G`); // 1-based absolute column → col 6
    grid.feed('x');
    expect(grid.text()[1]).toBe('def   x');
    grid.feed(`${ESC}[2;3H`); // 1-based row and column → row 1, col 2
    grid.feed('y');
    expect(grid.text()[1]).toBe('dey   x');
    grid.feed(`${ESC}[H`);
    expect(grid.cursor()).toEqual({ row: 0, col: 0 });
  });

  it('erase-in-line takes modes: to the end, to the start, the whole line', () => {
    const grid = screenGrid({ columns: 10, rows: 3 });
    grid.feed('0123456789\r');
    grid.feed(`${ESC}[4G${ESC}[K`); // erase from col 3 to EOL
    expect(grid.text()[0]).toBe('012');
    grid.feed(`${ESC}[2G${ESC}[1K`); // erase up to and including col 1
    expect(grid.text()[0]).toBe('  2');
    grid.feed(`${ESC}[2K`);
    expect(grid.text()[0]).toBe('');
    expect(grid.cursor()).toEqual({ row: 0, col: 1 });
  });

  it('erase-in-display clears below, above or the whole screen', () => {
    const grid = screenGrid({ columns: 10, rows: 5 });
    grid.feed('one\ntwo\nthree');
    grid.feed(`${ESC}[1A\r${ESC}[J`); // upAndClear(1): cursor lands on 'two', everything below is gone
    expect(grid.text()).toEqual(['one', '', '', '', '']);
    expect(grid.cursor()).toEqual({ row: 1, col: 0 });

    const up = screenGrid({ columns: 10, rows: 5 });
    up.feed('one\ntwo\nthree');
    up.feed(`${ESC}[2G${ESC}[1J`); // erase rows above and the cursor row up to col 1
    expect(up.text()).toEqual(['', '', '  ree', '', '']);

    const all = screenGrid({ columns: 10, rows: 5 });
    all.feed('one\ntwo\nthree');
    all.feed(`${ESC}[2J`);
    expect(all.text()).toEqual(['', '', '', '', '']);
  });
});

describe('screenGrid: wrapping, scrolling and wide characters', () => {
  it('wraps an over-long line onto the next row', () => {
    const grid = screenGrid({ columns: 80, rows: 5 });
    grid.feed('x'.repeat(83));
    expect(grid.text()[0]).toBe('x'.repeat(80));
    expect(grid.text()[1]).toBe('xxx');
    for (const line of grid.text()) expect(displayWidth(line)).toBeLessThanOrEqual(80);
  });

  it('a line of exactly `columns` cells then a newline does not leave a blank row (pending wrap)', () => {
    const grid = screenGrid({ columns: 10, rows: 5 });
    grid.feed(`${'y'.repeat(10)}\nz`);
    expect(grid.text()).toEqual(['y'.repeat(10), 'z', '', '', '']);
    expect(grid.cursor()).toEqual({ row: 1, col: 1 });
  });

  it('scrolls up when writing past the last row', () => {
    const grid = screenGrid({ columns: 10, rows: 3 });
    grid.feed('a\nb\nc\nd\ne\nf\n');
    expect(grid.text()).toEqual(['e', 'f', '']); // every newline at the bottom scrolls one row off
  });

  it('gives wide glyphs two cells and never splits a pair at the edge', () => {
    const grid = screenGrid({ columns: 6, rows: 4 });
    grid.feed('ab世c界'); // 界 does not fit in the last cell: it wraps whole and cell 5 stays blank
    expect(grid.text()[0]).toBe('ab世 c');
    expect(grid.text()[1]).toBe('界');
    expect(displayWidth(grid.text()[0] as string)).toBe(6);
  });

  it('combining marks join the previous cell instead of taking one', () => {
    const grid = screenGrid({ columns: 10, rows: 2 });
    grid.feed('étude'); // 'e' + U+0301
    expect(grid.text()[0]).toBe('étude');
    expect(displayWidth(grid.text()[0] as string)).toBe(5);
    expect(grid.cursor()).toEqual({ row: 0, col: 5 });
  });
});

describe('screenGrid: sequences split across feed() calls', () => {
  it('buffers an escape sequence until it is complete', () => {
    const grid = screenGrid({ columns: 10, rows: 3 });
    grid.feed('abc\r'); // cursor back at col 0 over 'abc'
    grid.feed(`${ESC}[`);
    grid.feed('2');
    grid.feed('K');
    grid.feed('z');
    expect(grid.text()[0]).toBe('z');
  });
});

describe('screenGrid with selectMenu', () => {
  it.each([{ columns: 40, rows: 8 }, { columns: 80, rows: 24 }])(
    'shows a picked item as a single echo row and leaves no list behind ($columns x $rows)',
    async ({ columns, rows }) => {
      const { tty, ui, grid, pump, start } = openMenu({ columns, rows });
      const pending = start();
      pump();
      // The list: title, one row per item, hint — pointer on the first item.
      expect(nonBlank(grid)).toHaveLength(2 + ITEMS.length);
      expect(grid.text()[1]?.startsWith(ui.icons.pointer)).toBe(true);

      await tty.send(`${ESC}[B${ESC}[B`); // down twice → 'Language'
      pump();
      const pointerRow = grid.text().findIndex((line) => line.startsWith(ui.icons.pointer));
      expect(grid.text()[pointerRow]).toContain('Language');

      await tty.send('\r');
      pump();
      const result = await pending;
      expect(result).toEqual({ picked: true, value: 'lang', label: 'Language' });

      // Only the echo is left: every list row erased, exactly one non-blank row holds the choice.
      const visible = nonBlank(grid);
      expect(visible).toHaveLength(1);
      expect(visible[0]).toContain('Language');
      expect(visible[0]?.startsWith(ui.icons.arrow)).toBe(true);
      expect(grid.text().some((line) => line.includes('Check a CSV file') || line.includes('Quit'))).toBe(false);
      for (const line of grid.text()) expect(displayWidth(line)).toBeLessThanOrEqual(columns);
      // Nothing was scrolled away: every byte stays inside the grid.
      expect(grid.cursor().row).toBeGreaterThan(0);
    },
  );

  it('leaves the cursor on the row after the echo, so the next prompt does not collide', async () => {
    const { tty, grid, pump, start } = openMenu({ columns: 40, rows: 8 });
    const pending = start();
    pump();
    expect(nonBlank(grid).length).toBeGreaterThan(0);
    await tty.send('\r'); // pick 'Check a CSV file' (first item)
    pump();
    await pending;
    const lastTextRow = grid.text().findLastIndex((line) => line.trim() !== '');
    expect(lastTextRow).toBeGreaterThanOrEqual(0); // the echo is on screen
    expect(grid.cursor()).toEqual({ row: lastTextRow + 1, col: 0 });
  });

  it('q cancels: the whole list is erased and nothing is echoed', async () => {
    const { tty, grid, pump, start } = openMenu({ columns: 40, rows: 8 });
    const pending = start();
    pump();
    await tty.send('q');
    pump();
    const result = await pending;
    expect(result).toEqual({ picked: false });
    expect(nonBlank(grid)).toHaveLength(0);
    expect(grid.cursor().col).toBe(0);
  });

  it('redraws a trimmed viewport in a small window without leftovers', async () => {
    const items: SelectItem<number>[] = Array.from({ length: 20 }, (_, i) => ({ value: i, label: `entry ${i}` }));
    const { tty, ui, grid, pump, start } = openMenu<number>({ columns: 40, rows: 8, items });
    const pending = start();
    pump();
    for (let i = 0; i < 12; i += 1) await tty.send(`${ESC}[B`);
    pump();
    // The highlighted row sits deep in the viewport; every row still fits the window.
    const pointerRow = grid.text().findIndex((line) => line.startsWith(ui.icons.pointer));
    expect(grid.text()[pointerRow]).toContain('entry 12');
    for (const line of grid.text()) expect(displayWidth(line)).toBeLessThanOrEqual(40);
    // The viewport was trimmed: both "more" markers show and the first entries are gone.
    const snapshot = grid.snapshot();
    expect(snapshot).toContain('↑');
    expect(snapshot).toContain('↓');
    expect(snapshot).not.toContain('entry 0');
    expect(snapshot).toContain(HINT);

    await tty.send('\r');
    pump();
    const result = await pending;
    expect(result).toEqual({ picked: true, value: 12, label: 'entry 12' });
    expect(nonBlank(grid)).toHaveLength(1);
    expect(nonBlank(grid)[0]).toContain('entry 12');
  });
});

describe('screenGrid with redrawn one-line indicators', () => {
  it('a Spinner stays on one line and stop() leaves the grid clean', () => {
    vi.useFakeTimers();
    const tty = fakeTty({ columns: 40, rows: 6 });
    const ui = createUi(tty.io.output as never, RICH_ENV);
    const grid = screenGrid({ columns: 40, rows: 6 });
    let seen = 0;
    const pump = () => {
      const screen = tty.screen();
      grid.feed(screen.slice(seen));
      seen = screen.length;
    };

    const spinner = new Spinner(tty.io.output, ui, 'checking numbers');
    spinner.start();
    pump();
    expect(nonBlank(grid)).toHaveLength(1);
    const frame = nonBlank(grid)[0];

    vi.advanceTimersByTime(250); // two and a half redraws
    pump();
    expect(nonBlank(grid)).toHaveLength(1); // still one line: the redraws did not stack
    expect(nonBlank(grid)[0]).not.toBe(frame); // the frame did change
    expect(grid.cursor().row).toBeGreaterThanOrEqual(0);

    spinner.stop();
    pump();
    expect(nonBlank(grid)).toHaveLength(0);
    expect(grid.cursor()).toEqual({ row: 0, col: 0 });
    spinner.stop(); // idempotent
  });

  it('the progress bar is redrawn in place and finish() removes it', () => {
    vi.useFakeTimers();
    const tty = fakeTty({ columns: 60, rows: 8 });
    const ui = createUi(tty.io.output as never, RICH_ENV);
    const grid = screenGrid({ columns: 60, rows: 8 });
    let seen = 0;
    const pump = () => {
      const screen = tty.screen();
      grid.feed(screen.slice(seen));
      seen = screen.length;
    };
    let clock = 1_000_000;
    const renderer = new ProgressRenderer({
      mode: 'bar',
      ui,
      stream: tty.io.output,
      line: () => undefined,
      now: () => clock,
    });
    const event = (remaining: number): ProgressEvent => ({ app: 'telegram', needed: 4, remaining });

    renderer.update(event(4));
    vi.advanceTimersByTime(150); // a tick draws the bar
    pump();
    expect(nonBlank(grid)).toHaveLength(1);
    const firstBar = nonBlank(grid)[0] as string;
    expect(displayWidth(firstBar)).toBeLessThanOrEqual(60);
    expect(firstBar).toContain('0%');

    renderer.update(event(2));
    vi.advanceTimersByTime(150);
    pump();
    expect(nonBlank(grid)).toHaveLength(1); // redrawn in place, still a single row
    expect(nonBlank(grid)[0]).toContain('50%');

    renderer.update(event(0));
    renderer.finish();
    pump();
    expect(nonBlank(grid)).toHaveLength(0); // erase() cleared the bar line
    expect(grid.cursor().col).toBe(0);
  });

  it('wrapLog leaves the log lines above the bar', () => {
    vi.useFakeTimers();
    const tty = fakeTty({ columns: 60, rows: 8 });
    const ui = createUi(tty.io.output as never, RICH_ENV);
    const grid = screenGrid({ columns: 60, rows: 8 });
    let seen = 0;
    const pump = () => {
      const screen = tty.screen();
      grid.feed(screen.slice(seen));
      seen = screen.length;
    };
    const renderer = new ProgressRenderer({
      mode: 'bar',
      ui,
      stream: tty.io.output,
      line: () => undefined,
      now: () => 1_000_000,
    });
    const log = renderer.wrapLog((message) => {
      tty.io.output.write(`${message}\n`);
    });

    renderer.update({ app: 'telegram', needed: 4, remaining: 4 });
    vi.advanceTimersByTime(150);
    log('note one');
    pump();
    const visible = nonBlank(grid);
    expect(visible).toHaveLength(2);
    expect(visible[0]).toBe('note one');
    expect(visible[1]).toContain('0%'); // the bar lives on the last row again

    log('note two');
    pump();
    expect(nonBlank(grid)).toHaveLength(3);
    expect(nonBlank(grid)[0]).toBe('note one');
    expect(nonBlank(grid)[1]).toBe('note two');
    expect(nonBlank(grid)[2]).toContain('0%');
  });
});
