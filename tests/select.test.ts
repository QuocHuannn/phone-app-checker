import { describe, expect, it } from 'vitest';
import { PromptCancelled } from '../src/prompt.ts';
import { canSelect, guardTerminal, parseKeys, selectMenu, type SelectItem } from '../src/select.ts';
import { createUi, stripAnsi } from '../src/ui.ts';
import { fakeProcess, fakeTty } from './helpers/fake-tty.ts';

const ESC = '\u001b';
const RICH_ENV = { TERM: 'xterm-256color' };
const ITEMS: SelectItem<string>[] = [
  { value: 'check', label: 'Check a CSV file', key: '1' },
  { value: 'login', label: 'Log in an app account', key: '2' },
  { value: 'lang', label: 'Language', key: 'L' },
  { value: 'quit', label: 'Quit', key: '0' },
];
const HINT = '↑↓ move · Enter select · q quit';

function open(options: { columns?: number; rawMode?: boolean } = {}) {
  const tty = fakeTty(options);
  const ui = createUi(tty.io.output as never, RICH_ENV);
  const proc = fakeProcess();
  const start = (initial?: number) => {
    const pending = selectMenu(tty.io, ui, { title: 'Main menu', items: ITEMS, hint: HINT, ...(initial === undefined ? {} : { initial }) }, proc);
    // Rejections are asserted by the tests; this only stops Node from flagging them before the assertion attaches.
    pending.catch(() => undefined);
    return pending;
  };
  return { tty, ui, proc, start };
}

/** The visible text after the last redraw: what a user would see on screen. */
const lastFrame = (screen: string): string => {
  const frames = stripAnsi(screen).split('\r').filter((part) => part !== '');
  return frames.at(-1) ?? '';
};

describe('parseKeys', () => {
  it.each([
    [`${ESC}[A`, [{ name: 'up' }]],
    [`${ESC}[B`, [{ name: 'down' }]],
    [`${ESC}OA`, [{ name: 'up' }]],
    [`${ESC}OB`, [{ name: 'down' }]],
    [`${ESC}[H`, [{ name: 'home' }]],
    [`${ESC}[F`, [{ name: 'end' }]],
    ['\r', [{ name: 'enter' }]],
    ['\n', [{ name: 'enter' }]],
    ['\r\n', [{ name: 'enter' }]],
    [ESC, [{ name: 'esc' }]],
    ['\u0003', [{ name: 'ctrl-c' }]],
    ['\u0004', [{ name: 'ctrl-d' }]],
    ['\u007f', [{ name: 'backspace' }]],
    ['q', [{ name: 'char', char: 'q' }]],
    ['5', [{ name: 'char', char: '5' }]],
    [`${ESC}[A${ESC}[B\r`, [{ name: 'up' }, { name: 'down' }, { name: 'enter' }]],
    [`${ESC}[1;5C`, []],
    [`${ESC}[200~`, []],
    ['\u0001', []],
  ])('%j', (chunk, keys) => {
    expect(parseKeys(chunk)).toEqual(keys);
  });
});

describe('canSelect', () => {
  it('needs a rich output and an input with raw mode', () => {
    const tty = fakeTty();
    expect(canSelect(tty.io, createUi(tty.io.output as never, RICH_ENV))).toBe(true);
    expect(canSelect(tty.io, createUi(tty.io.output as never, { ...RICH_ENV, NO_COLOR: '1' }))).toBe(false);
    expect(canSelect(tty.io, createUi(tty.io.output as never, { TERM: 'dumb' }))).toBe(false);
    const noRaw = fakeTty({ rawMode: false });
    expect(canSelect(noRaw.io, createUi(noRaw.io.output as never, RICH_ENV))).toBe(false);
    const piped = fakeTty();
    Object.assign(piped.io.input, { isTTY: false });
    expect(canSelect(piped.io, createUi(piped.io.output as never, RICH_ENV))).toBe(false);
  });
});

describe('selectMenu: arrow keys, number keys, q / Esc', () => {
  it('draws the title, the rows, the pointer on the first row and the hint, and hides the cursor', async () => {
    const { tty, start } = open();
    const pending = start();
    expect(tty.rawModes).toEqual([true]);
    const screen = tty.screen();
    expect(screen).toContain(`${ESC}[?25l`);
    const text = stripAnsi(screen);
    expect(text).toContain('Main menu');
    expect(text).toContain('❯ 1 Check a CSV file');
    expect(text).toContain('  2 Log in an app account');
    expect(text).toContain(HINT);
    await tty.send('\u0003');
    await expect(pending).rejects.toBeInstanceOf(PromptCancelled);
  });

  it('moves with ↓ / ↑ (wrapping around) and picks with Enter', async () => {
    const { tty, start } = open();
    const pending = start();
    await tty.send(`${ESC}[B`);
    expect(lastFrame(tty.screen())).toContain('❯ 2 Log in an app account');
    await tty.send(`${ESC}[B`);
    await tty.send(`${ESC}[B`);
    await tty.send(`${ESC}[B`);
    // 4 rows: four downs wrap back to the first.
    expect(lastFrame(tty.screen())).toContain('❯ 1 Check a CSV file');
    await tty.send(`${ESC}[A`);
    expect(lastFrame(tty.screen())).toContain('❯ 0 Quit');
    await tty.send('\r');
    await expect(pending).resolves.toEqual({ picked: true, value: 'quit', label: 'Quit' });
  });

  it('redraws in place: each frame first moves up over the previous one and clears it', async () => {
    const { tty, start } = open();
    const pending = start();
    await tty.send(`${ESC}[B`);
    // title + 4 rows + hint = 6 lines.
    expect(tty.screen()).toContain(`${ESC}[6A\r${ESC}[J`);
    await tty.send('2');
    await pending;
  });

  it('picks a row at once with its own key, case-insensitively (1, 0, l / L)', async () => {
    for (const [key, value] of [['1', 'check'], ['2', 'login'], ['0', 'quit'], ['l', 'lang'], ['L', 'lang']] as const) {
      const { tty, start } = open();
      const pending = start();
      await tty.send(key);
      await expect(pending, key).resolves.toMatchObject({ picked: true, value });
      expect(tty.rawModes).toEqual([true, false]);
    }
  });

  it('ignores keys that match nothing and keeps waiting', async () => {
    const { tty, start } = open();
    let settled = false;
    const pending = start().then((result) => {
      settled = true;
      return result;
    });
    await tty.send('z');
    await tty.send('9');
    await tty.send(`${ESC}[C`);
    expect(settled).toBe(false);
    await tty.send('\r');
    await expect(pending).resolves.toMatchObject({ picked: true, value: 'check' });
  });

  it('q and Esc back out: nothing picked', async () => {
    for (const key of ['q', 'Q', ESC]) {
      const { tty, start } = open();
      const pending = start();
      await tty.send(key);
      await expect(pending, JSON.stringify(key)).resolves.toEqual({ picked: false });
    }
  });

  it('starts on the requested row and handles Home / End', async () => {
    const { tty, start } = open();
    const pending = start(2);
    expect(stripAnsi(tty.screen())).toContain('❯ L Language');
    await tty.send(`${ESC}[H`);
    expect(lastFrame(tty.screen())).toContain('❯ 1 Check a CSV file');
    await tty.send(`${ESC}[F`);
    expect(lastFrame(tty.screen())).toContain('❯ 0 Quit');
    await tty.send('q');
    await pending;
  });

  it('several keys in one chunk are all handled (fast typing, paste)', async () => {
    const { tty, start } = open();
    const pending = start();
    await tty.send(`${ESC}[B${ESC}[B\r`);
    await expect(pending).resolves.toMatchObject({ value: 'lang' });
  });

  it('leaves one dim echo of the choice and removes the menu from the screen', async () => {
    const { tty, start } = open();
    const pending = start();
    await tty.send('2');
    await pending;
    const screen = tty.screen();
    // The last thing drawn is the erase of the block, then the echo line.
    expect(screen).toContain(`${ESC}[6A\r${ESC}[J${ESC}[?25h`);
    expect(stripAnsi(screen).trimEnd().endsWith('› Log in an app account')).toBe(true);
  });

  it('truncates rows to the window width: no line is ever longer than the terminal', async () => {
    const { tty, start } = open({ columns: 30 });
    const pending = start();
    await tty.send('q');
    await pending;
    for (const line of stripAnsi(tty.screen()).split(/\r|\n/)) expect([...line].length).toBeLessThanOrEqual(29);
  });
});

describe('selectMenu: the terminal is always restored', () => {
  it('after a pick: raw mode off, input paused, listeners removed, cursor shown', async () => {
    const { tty, start } = open();
    const pending = start();
    expect(tty.flowing()).toBe(true);
    await tty.send('1');
    await pending;
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.flowing()).toBe(false);
    expect(tty.dataListeners()).toBe(0);
    expect(tty.screen()).toContain(`${ESC}[?25h`);
  });

  it.each([['Ctrl+C', '\u0003'], ['Ctrl+D', '\u0004']])('on %s: rejects with PromptCancelled and restores', async (_name, key) => {
    const { tty, start, proc } = open();
    const pending = start();
    await tty.send(key);
    await expect(pending).rejects.toBeInstanceOf(PromptCancelled);
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.screen()).toContain(`${ESC}[?25h`);
    expect(proc.listenerCount('SIGTERM')).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
  });

  it('when the input ends or errors: rejects and restores', async () => {
    const ended = open();
    const endPending = ended.start();
    ended.tty.io.input.emit('end');
    await expect(endPending).rejects.toBeInstanceOf(PromptCancelled);
    expect(ended.tty.rawModes).toEqual([true, false]);

    const broken = open();
    const brokenPending = broken.start();
    broken.tty.io.input.emit('error', new Error('read EIO'));
    await expect(brokenPending).rejects.toThrow('read EIO');
    expect(broken.tty.rawModes).toEqual([true, false]);
    expect(broken.tty.screen()).toContain(`${ESC}[?25h`);
  });

  it('when drawing throws: rejects with that error and restores', async () => {
    const tty = fakeTty();
    const ui = createUi(tty.io.output as never, RICH_ENV);
    const proc = fakeProcess();
    let writes = 0;
    const realWrite = tty.io.output.write.bind(tty.io.output);
    tty.io.output.write = ((chunk: string, ...rest: unknown[]) => {
      writes += 1;
      // 1 = hide cursor, 2 = first frame, 3 = the redraw after the key.
      if (writes === 3) throw new Error('EPIPE');
      return (realWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof tty.io.output.write;
    const pending = selectMenu(tty.io, ui, { items: ITEMS, hint: HINT }, proc);
    pending.catch(() => undefined);
    await tty.send(`${ESC}[B`);
    await expect(pending).rejects.toThrow('EPIPE');
    expect(tty.rawModes).toEqual([true, false]);
    expect(proc.listenerCount('SIGINT')).toBe(0);
  });

  it('when raw mode cannot be switched on: rejects instead of hanging, nothing left behind', async () => {
    const tty = fakeTty();
    Object.assign(tty.io.input, {
      setRawMode: () => {
        throw new Error('ENOTTY');
      },
    });
    const ui = createUi(tty.io.output as never, RICH_ENV);
    const proc = fakeProcess();
    await expect(selectMenu(tty.io, ui, { items: ITEMS, hint: HINT }, proc)).rejects.toThrow();
    expect(tty.dataListeners()).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ])('on %s while the menu is open: restores raw mode and the cursor, then exits with %d', async (signal, code) => {
    const { tty, start, proc } = open();
    void start().catch(() => undefined);
    expect(tty.rawModes).toEqual([true]);
    proc.emit(signal);
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.screen()).toContain(`${ESC}[?25h`);
    expect(proc.exits).toEqual([code]);
    expect(proc.listenerCount(signal)).toBe(0);
  });

  it('on process exit while open: restores the terminal too', async () => {
    const { tty, start, proc } = open();
    void start().catch(() => undefined);
    proc.emit('exit');
    expect(tty.rawModes).toEqual([true, false]);
    expect(tty.screen()).toContain(`${ESC}[?25h`);
  });
});

describe('guardTerminal', () => {
  it('restores once per event and the disposer removes every listener', () => {
    const proc = fakeProcess();
    let restored = 0;
    const dispose = guardTerminal(() => (restored += 1), proc);
    expect(['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map((event) => proc.listenerCount(event))).toEqual([1, 1, 1, 1]);
    dispose();
    expect(['SIGINT', 'SIGTERM', 'SIGHUP', 'exit'].map((event) => proc.listenerCount(event))).toEqual([0, 0, 0, 0]);
    expect(restored).toBe(0);
  });
});
