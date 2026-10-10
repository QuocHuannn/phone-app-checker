import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  box,
  charWidth,
  createUi,
  displayWidth,
  formatDuration,
  isRich,
  PLAIN_UI,
  Spinner,
  stripAnsi,
  strip,
  truncate,
  truncatePath,
  wrap,
} from '../src/ui.ts';

const ESC = '\u001b';
const TTY = { isTTY: true, columns: 100, rows: 30 };
const RICH_ENV = { TERM: 'xterm-256color' };

afterEach(() => {
  vi.useRealTimers();
});

describe('isRich / createUi: when ANSI is allowed', () => {
  it('needs a terminal, a usable TERM and no NO_COLOR', () => {
    expect(isRich(TTY, RICH_ENV)).toBe(true);
    expect(isRich({ isTTY: false }, RICH_ENV)).toBe(false);
    expect(isRich({}, RICH_ENV)).toBe(false);
    expect(isRich(TTY, { TERM: 'dumb' })).toBe(false);
    expect(isRich(TTY, { TERM: 'DUMB' })).toBe(false);
    expect(isRich(TTY, {})).toBe(false);
    expect(isRich(TTY, { TERM: '' })).toBe(false);
    expect(isRich(TTY, { ...RICH_ENV, NO_COLOR: '1' })).toBe(false);
    // no-color.org: an empty NO_COLOR counts as not set.
    expect(isRich(TTY, { ...RICH_ENV, NO_COLOR: '' })).toBe(true);
  });

  it('PHONE_APP_CHECKER_PLAIN (anything but empty) forces the plain tier on a good terminal', () => {
    expect(isRich(TTY, { ...RICH_ENV, PHONE_APP_CHECKER_PLAIN: '1' })).toBe(false);
    expect(isRich(TTY, { ...RICH_ENV, PHONE_APP_CHECKER_PLAIN: '' })).toBe(true);
    const ui = createUi(TTY, { ...RICH_ENV, PHONE_APP_CHECKER_PLAIN: '1' });
    expect(ui.rich).toBe(false);
    expect(ui.bold('x')).toBe('x');
    expect(ui.icons.ok).toBe('[ok]');
  });

  it('paints with standard SGR codes on a rich terminal, closing each style on its own so they nest', () => {
    const ui = createUi(TTY, RICH_ENV);
    expect(ui.rich).toBe(true);
    expect(ui.bold('x')).toBe(`${ESC}[1mx${ESC}[22m`);
    expect(ui.dim('x')).toBe(`${ESC}[2mx${ESC}[22m`);
    expect(ui.green('x')).toBe(`${ESC}[32mx${ESC}[39m`);
    expect(ui.yellow('x')).toBe(`${ESC}[33mx${ESC}[39m`);
    expect(ui.red('x')).toBe(`${ESC}[31mx${ESC}[39m`);
    expect(ui.cyan('x')).toBe(`${ESC}[36mx${ESC}[39m`);
    expect(ui.inverse('x')).toBe(`${ESC}[7mx${ESC}[27m`);
    expect(stripAnsi(ui.bold(ui.red('nested')))).toBe('nested');
  });

  it.each([
    ['NO_COLOR', TTY, { ...RICH_ENV, NO_COLOR: '1' }],
    ['TERM=dumb', TTY, { TERM: 'dumb' }],
    ['not a TTY', { isTTY: false, columns: 100 }, RICH_ENV],
    ['no stream info at all', {}, {}],
  ])('writes no ANSI at all and uses ASCII icons: %s', (_name, stream, env) => {
    const ui = createUi(stream, env);
    expect(ui.rich).toBe(false);
    for (const paint of [ui.bold, ui.dim, ui.red, ui.green, ui.yellow, ui.cyan, ui.inverse]) expect(paint('text')).toBe('text');
    const icons = Object.values(ui.icons).flat().join('');
    expect(icons).toMatch(/^[\x20-\x7e]*$/);
    expect(ui.icons.ok).toBe('[ok]');
  });

  it('uses Unicode icons on a rich terminal and PLAIN_UI is plain', () => {
    expect(createUi(TTY, RICH_ENV).icons.ok).toBe('✔');
    expect(PLAIN_UI.rich).toBe(false);
    expect(PLAIN_UI.bold('a')).toBe('a');
  });

  it('reads the window size each time, with sane defaults and a floor', () => {
    const stream = { isTTY: true, columns: 120, rows: 40 };
    const ui = createUi(stream, RICH_ENV);
    expect([ui.columns, ui.rows]).toEqual([120, 40]);
    stream.columns = 90;
    expect(ui.columns).toBe(90);
    stream.columns = 5;
    expect(ui.columns).toBe(20);
    expect([createUi({}, {}).columns, createUi({}, {}).rows]).toEqual([80, 24]);
  });
});

describe('display width', () => {
  it('counts ASCII 1, CJK / Hangul / full-width / emoji 2, combining marks 0', () => {
    expect(charWidth('a')).toBe(1);
    expect(charWidth('中')).toBe(2);
    expect(charWidth('한')).toBe(2);
    expect(charWidth('Ａ')).toBe(2);
    expect(charWidth('✅')).toBe(2);
    expect(charWidth('⬜')).toBe(2);
    expect(charWidth('🔍')).toBe(2);
    expect(charWidth('\u0301')).toBe(0);
    expect(charWidth('ế')).toBe(1);
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('e\u0301')).toBe(1);
    expect(displayWidth(`${ESC}[31mred${ESC}[39m`)).toBe(3);
  });
});

describe('truncate', () => {
  it('leaves text that fits alone', () => {
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('', 3)).toBe('');
  });

  it('cuts to the width including the ellipsis', () => {
    expect(truncate('hello world', 8)).toBe('hello w…');
    expect(displayWidth(truncate('hello world', 8))).toBe(8);
    expect(truncate('hello world', 8, '...')).toBe('hello...');
  });

  it('never splits a wide character and never exceeds the width', () => {
    for (const text of ['한국어 텍스트입니다', '简体中文，很长的一行文字', '🔍🔑👤📄🩺 emoji row', 'Tiếng Việt có dấu rất dài']) {
      for (const max of [4, 5, 6, 7, 10]) {
        const cut = truncate(text, max);
        expect(displayWidth(cut), `${text} @ ${max}`).toBeLessThanOrEqual(max);
      }
    }
    // The 2-column hangul does not fit in the 1 column left before the ellipsis.
    expect(truncate('한한한', 4)).toBe('한…');
  });

  it('keeps colour codes and closes a span the cut falls into', () => {
    const cut = truncate(`${ESC}[32mgreen text here${ESC}[39m`, 7);
    expect(stripAnsi(cut)).toBe('green …');
    expect(cut.endsWith(`${ESC}[0m…`)).toBe(true);
    expect(displayWidth(cut)).toBe(7);
  });
});

describe('truncatePath', () => {
  it('keeps short paths and cuts long ones from the left, keeping the file name', () => {
    expect(truncatePath('/tmp/report.csv', 40)).toBe('/tmp/report.csv');
    const long = '/Users/boss/Documents/Customers 2026/October/batch-17/report.csv';
    const cut = truncatePath(long, 30);
    expect(displayWidth(cut)).toBeLessThanOrEqual(30);
    expect(cut.startsWith('…/')).toBe(true);
    expect(cut.endsWith('/report.csv')).toBe(true);
  });

  it('falls back to a hard cut when even the file name is too long, and never exceeds the width', () => {
    const cut = truncatePath('/a/b/' + 'x'.repeat(100) + '.csv', 20);
    expect(displayWidth(cut)).toBeLessThanOrEqual(20);
    expect(cut.endsWith('.csv')).toBe(true);
    for (const max of [8, 12, 40]) expect(displayWidth(truncatePath('/Users/khách hàng/báo cáo/한국어/中文.csv', max))).toBeLessThanOrEqual(max);
  });
});

describe('wrap', () => {
  it('breaks at spaces, keeps explicit line breaks, and never exceeds the width', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
    expect(wrap('a\nb', 10)).toEqual(['a', 'b']);
    expect(wrap('', 10)).toEqual(['']);
    expect(wrap('short', 10)).toEqual(['short']);
  });

  it('breaks long words and CJK text anywhere without splitting a wide character', () => {
    const lines = wrap('这是一段没有空格的很长的中文文字需要折行', 10);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(10);
    expect(lines.join('')).toBe('这是一段没有空格的很长的中文文字需要折行');
    for (const line of wrap('x'.repeat(25), 10)) expect(line.length).toBeLessThanOrEqual(10);
  });

  it('carries escape sequences along unbroken', () => {
    const lines = wrap(`${ESC}[1mbold words that wrap${ESC}[22m`, 10);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(10);
    expect(stripAnsi(lines.join(' '))).toBe('bold words that wrap');
    expect(lines.join('')).toContain(`${ESC}[1m`);
  });

  it('keeps a paragraph\'s leading indent on every wrapped line (hanging indent) and never indents a blank line', () => {
    const lines = wrap('  1) Open the page and sign in with the phone number\n\n    deeper indent text that wraps too', 24);
    expect(lines).toEqual(['  1) Open the page and', '  sign in with the phone', '  number', '', '    deeper indent text', '    that wraps too']);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(24);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0 s'],
    [42_000, '42 s'],
    [59_400, '59 s'],
    [60_000, '1 min'],
    [5 * 60_000, '5 min'],
    [3_600_000 + 5 * 60_000, '1 h 05 min'],
    [-5, '0 s'],
  ])('%d ms -> %s', (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});

describe('box and strip', () => {
  const rich = createUi({ isTTY: true, columns: 80, rows: 24 }, RICH_ENV);

  it('draws a titled frame with a left bar only, so mixed-width text can never misalign a border', () => {
    const lines = box(rich, 'Report saved to /tmp/r.csv', ['plain line', '한국어 텍스트', '✅ emoji line'], 'ok');
    const plain = lines.map(stripAnsi);
    expect(plain[0]).toMatch(/^╭─ Report saved to \/tmp\/r\.csv ─+$/);
    expect(plain.at(-1)).toMatch(/^╰─+$/);
    expect(plain.slice(1, -1)).toEqual(['│ plain line', '│ 한국어 텍스트', '│ ✅ emoji line']);
    expect(plain.every((line) => displayWidth(line) <= rich.columns - 1)).toBe(true);
  });

  it('wraps long lines inside the window and truncates a long title', () => {
    const narrow = createUi({ isTTY: true, columns: 40, rows: 24 }, RICH_ENV);
    const lines = box(narrow, 'A very long title that cannot possibly fit in forty columns', ['word '.repeat(30)]).map(stripAnsi);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(39);
    expect(lines[0]).toContain('…');
  });

  it('is plain ASCII with no escape sequences when not rich', () => {
    const lines = box(PLAIN_UI, 'Title', ['body', { text: 'warn', paint: (text) => `<${text}>` }], 'warn');
    expect(lines[0]).toMatch(/^\+- Title -+$/);
    expect(lines.slice(1, -1)).toEqual(['| body', '| <warn>']);
    expect(lines.at(-1)).toMatch(/^\+-+$/);
    expect(lines.join('\n')).not.toContain(ESC);
  });

  it('strip joins items and wraps to the window', () => {
    expect(strip(rich, ['✅ whatsapp 1', '⬜ telegram –'])).toEqual(['✅ whatsapp 1 · ⬜ telegram –']);
    const narrow = createUi({ isTTY: true, columns: 30, rows: 24 }, RICH_ENV);
    const lines = strip(narrow, ['✅ whatsapp 1', '⬜ telegram –', '⬜ zalo –', '⬜ viber –']);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(26);
  });
});

describe('Spinner', () => {
  function sink() {
    const writes: string[] = [];
    return { writes, stream: { write: (text: string) => writes.push(text) } };
  }

  it('writes nothing at all when the output is not a rich terminal', () => {
    vi.useFakeTimers();
    const { writes, stream } = sink();
    const spinner = new Spinner(stream, PLAIN_UI, 'Connecting...').start();
    vi.advanceTimersByTime(1000);
    spinner.update('Still connecting');
    spinner.stop();
    expect(writes).toEqual([]);
    const noColor = createUi(TTY, { ...RICH_ENV, NO_COLOR: '1' });
    new Spinner(stream, noColor, 'x').start().stop();
    expect(writes).toEqual([]);
  });

  it('animates in place on a rich terminal and erases its line on stop (once)', () => {
    vi.useFakeTimers();
    const { writes, stream } = sink();
    const ui = createUi(TTY, RICH_ENV);
    const spinner = new Spinner(stream, ui, 'Connecting...', 100).start();
    // First frame: a line of its own (ends with a newline); later frames move up one line and redraw it.
    expect(stripAnsi(writes[0] ?? '')).toBe('⠋ Connecting...\n');
    vi.advanceTimersByTime(250);
    expect(writes.length).toBe(3);
    expect(stripAnsi(writes[1] ?? '')).toBe('\r⠙ Connecting...\n'.replace('\r', '\r'));
    spinner.update('Waiting...');
    expect(stripAnsi(writes.at(-1) ?? '')).toContain('Waiting...');
    const before = writes.length;
    spinner.stop();
    expect(writes.at(-1)).toBe(`${ESC}[1A\r${ESC}[J`);
    spinner.stop();
    vi.advanceTimersByTime(1000);
    expect(writes.length).toBe(before + 1);
  });
});
