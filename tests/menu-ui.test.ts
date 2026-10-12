import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { saveTelegramCredentials } from '../src/config-write.ts';
import { runMenu, type CommandResult, type MenuHost } from '../src/menu.ts';
import { TELEGRAM_APPS_URL } from '../src/open-url.ts';
import { openRecentFiles } from '../src/recent.ts';
import type { App } from '../src/types.ts';
import { displayWidth, stripAnsi } from '../src/ui.ts';
import { fakeTty, type FakeTty } from './helpers/fake-tty.ts';
import { scriptedTerminal } from './helpers/menu-io.ts';
import { screenGrid } from './helpers/screen-grid.ts';

const ESC = '\u001b';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const RICH_ENV = { TERM: 'xterm-256color' };
const HASH = '0123456789abcdef0123456789abcdef';
const EN = ['--lang', 'en'];
const CSV = 'name,phone\nAn,0901234567\n';

let dir: string;
let work: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pac-menu-ui-'));
  work = join(dir, 'work');
  mkdirSync(work);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

interface Setup {
  accounts?: Partial<Record<App, string[]>>;
  telegram?: { apiId: number; apiHash: string };
  results?: CommandResult[];
  env?: NodeJS.ProcessEnv;
  openUrl?: MenuHost['openUrl'];
  saveTheme?: MenuHost['saveTheme'];
}

function build(io: MenuHost['io'], setup: Setup = {}) {
  const dataDir = join(dir, 'data');
  for (const [app, names] of Object.entries(setup.accounts ?? {})) {
    for (const name of names ?? []) mkdirSync(join(dataDir, 'sessions', app, name), { recursive: true });
  }
  const configFile = join(dir, 'config.json');
  writeFileSync(configFile, JSON.stringify({ dataDir, apps: { telegram: { options: setup.telegram ?? {} } } }));
  const runs: string[][] = [];
  const opened: string[] = [];
  const results = [...(setup.results ?? [])];
  const host: MenuHost = {
    io,
    version: 'v9.9.9',
    cwd: work,
    homeDir: '/home/tester',
    env: setup.env ?? RICH_ENV,
    loadConfig: () => loadConfig(configFile),
    configFile: () => configFile,
    saveTelegramCredentials: (apiId, apiHash) => saveTelegramCredentials(configFile, apiId, apiHash),
    run: async (args) => {
      runs.push(args);
      return results.shift() ?? { code: 0 };
    },
    ...(setup.openUrl === undefined
      ? {
          openUrl: async (url: string) => {
            opened.push(url);
            return true;
          },
        }
      : { openUrl: setup.openUrl }),
    ...(setup.saveTheme === undefined ? {} : { saveTheme: setup.saveTheme }),
  };
  return { host, runs, opened, configFile };
}

/**
 * A colour terminal of the given size, as a real window is: the QR fit check sizes the code for colour output
 * (half-blocks) when the stream reports a colour depth, and for the much bigger plain output when it does not.
 */
function colourTty(columns = 120, rows = 60): FakeTty {
  const tty = fakeTty({ columns, rows });
  Object.assign(tty.io.output, { getColorDepth: () => 8 });
  return tty;
}

/** The user drags a window corner: the menu reads the size again each time it needs it. */
function resize(tty: FakeTty, columns: number, rows: number): void {
  Object.assign(tty.io.output, { columns, rows });
}

/**
 * The screen as a person reads it: ANSI removed and every run of blanks / line breaks one space, so a sentence the
 * menu wrapped at the window width still matches. Positions returned by `until` index into this text.
 */
const view = (tty: FakeTty): string => stripAnsi(tty.screen()).replace(/\s+/g, ' ');

/** Wait until `text` is on screen, after the first `from` characters of `view`. */
async function until(tty: FakeTty, text: string, from = 0): Promise<number> {
  const wanted = text.replace(/\s+/g, ' ');
  for (let tries = 0; tries < 400; tries += 1) {
    const plain = view(tty);
    const at = plain.indexOf(wanted, from);
    if (at >= 0) return at + text.length;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`never saw ${JSON.stringify(text)} on screen:\n${view(tty).slice(-900)}`);
}

/** Wait for `text`, then send `keys`; returns the screen position after `text` for the next wait. */
async function answer(tty: FakeTty, text: string, keys: string, from = 0): Promise<number> {
  const at = await until(tty, text, from);
  await tty.send(keys);
  return at;
}

/** Wait until something that is not on screen (a command that was run) has happened. */
async function settle(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 400 && !condition(); tries += 1) await new Promise((resolve) => setImmediate(resolve));
  expect(condition()).toBe(true);
}

/** The menu is drawn again after every action; quit from it (needs the banner, so a window of 20 rows or more). */
async function quitFrom(tty: FakeTty, from: number): Promise<void> {
  const again = await until(tty, 'Accounts ready:', from);
  await answer(tty, '↑↓ move · Enter select', '0', again);
}

/** Menu item 1 up to and including the "use this file?" answer; returns the screen position after it. */
async function chooseCsv(tty: FakeTty, csv: string): Promise<number> {
  let at = await answer(tty, 'q quit', '1');
  at = await answer(tty, 'CSV file (b = back): ', `${csv}\r`, at);
  return answer(tty, 'Use this file? (Enter = continue, b = pick another): ', '\r', at);
}

describe('rich main menu (arrow keys on a real terminal)', () => {
  it('shows the banner with name, version and the accounts strip, the rows with their keys, and the hint footer', async () => {
    const tty = fakeTty({ columns: 100 });
    const { host } = build(tty.io, { accounts: { whatsapp: ['default'] } });
    const done = runMenu(host);
    await until(tty, '↑↓ move · Enter select · q quit');
    const screen = view(tty);
    expect(screen).toContain('╭─ Phone App Checker v9.9.9');
    expect(screen).toContain('Accounts ready:');
    // Icon and word together: the state never rests on a symbol or a colour alone.
    expect(screen).toContain('✔ whatsapp 1 account');
    for (const app of ['telegram', 'zalo', 'viber', 'line']) expect(screen).toContain(`○ ${app} none`);
    for (const row of ['1 Check a CSV file', '2 Log in an app account', '3 View logged-in accounts', '5 Guide / warnings', '6 Settings', '0 Quit']) {
      expect(screen).toContain(row);
    }
    expect(screen).toContain('L Language / Ngôn ngữ / Bahasa / 언어 / 语言: English');
    expect(screen).toContain('❯ 1 Check a CSV file');
    // No double-width emoji in the chrome: they misalign the columns in many terminals.
    expect(screen).not.toMatch(/[✅⬜🔍🔑👤📖🚪🌐]/u);
    await tty.send('0');
    expect(await done).toBe(0);
    expect(tty.rawModes.at(-1)).toBe(false);
  });

  it('navigates with the arrow keys and Enter: ↓↓ then Enter opens item 3 (accounts), b goes back, q quits', async () => {
    const tty = fakeTty();
    const { host, runs } = build(tty.io, { accounts: { telegram: ['a'] }, results: [{ code: 0 }] });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', `${DOWN}${DOWN}\r`);
    at = await until(tty, '› View logged-in accounts', at);
    at = await until(tty, 'r reset cooldown', at);
    await tty.send('b');
    at = await until(tty, 'Accounts ready:', at);
    await answer(tty, 'q quit', 'q', at);
    expect(await done).toBe(0);
    expect(runs).toEqual([['accounts']]);
    expect(view(tty)).toContain('Goodbye.');
  });

  it('↑ from the first row wraps to the last (Quit); Esc also quits', async () => {
    const tty = fakeTty();
    const { host } = build(tty.io);
    const done = runMenu(host);
    await answer(tty, 'q quit', UP);
    await until(tty, '❯ 0 Quit');
    await tty.send(ESC);
    expect(await done).toBe(0);
    expect(view(tty)).toContain('Goodbye.');
  });

  it('number keys pick at once: 6 shows the guide in a box and waits for Enter before the menu comes back, then 0 quits', async () => {
    const tty = fakeTty();
    const { host, runs } = build(tty.io);
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '5');
    at = await until(tty, '╭─ GUIDE AND WARNINGS', at);
    expect(view(tty)).toContain('│ - Only check numbers of people who agreed to be contacted.');
    at = await answer(tty, 'Press Enter for the menu.', '\r', at);
    await quitFrom(tty, at);
    expect(await done).toBe(0);
    expect(runs).toEqual([]);
  });

  it('shows a friendly empty state instead of running `accounts` when nobody is logged in', async () => {
    const tty = fakeTty();
    const { host, runs } = build(tty.io);
    const done = runMenu(host);
    await answer(tty, 'q quit', '3');
    await until(tty, 'No account is logged in yet. Choose "Log in an app account" first');
    await tty.send('q');
    await done;
    expect(runs).toEqual([]);
  });

  it('L opens the language list (arrow keys, current language starred) and a number switches it at once', async () => {
    const tty = fakeTty();
    const { host } = build(tty.io);
    const saved: string[] = [];
    host.saveLanguage = (lang) => void saved.push(lang);
    const done = runMenu(host);
    const at = await answer(tty, 'q quit', 'l');
    await until(tty, '❯ 1 English *', at);
    await tty.send('2');
    await until(tty, 'Ngôn ngữ: Tiếng Việt.');
    // The whole menu is now Vietnamese.
    await until(tty, '↑↓ di chuyển · Enter chọn · q thoát');
    await tty.send('0');
    await done;
    expect(saved).toEqual(['vi']);
  });

  it('Ctrl+C at the menu says goodbye and leaves the terminal as it found it', async () => {
    const tty = fakeTty();
    const { host } = build(tty.io);
    const done = runMenu(host);
    await answer(tty, 'q quit', '\u0003');
    expect(await done).toBe(0);
    expect(view(tty)).toContain('Goodbye.');
    expect(tty.rawModes.at(-1)).toBe(false);
    expect(tty.screen()).toContain(`${ESC}[?25h`);
  });

  it('falls back to the numbered prompt when raw mode is not available (banner and colours stay)', async () => {
    const tty = fakeTty({ rawMode: false });
    const { host } = build(tty.io);
    const done = runMenu(host);
    await until(tty, 'Choose 0-6 or L, then Enter: ');
    const screen = view(tty);
    expect(screen).toContain('╭─ Phone App Checker v9.9.9');
    expect(screen).toContain('1. Check a CSV file');
    expect(screen).not.toContain('↑↓ move');
    await tty.send('0\r');
    expect(await done).toBe(0);
  });

  it.each([
    ['NO_COLOR', { TERM: 'xterm-256color', NO_COLOR: '1' }],
    ['TERM=dumb', { TERM: 'dumb' }],
    ['no TERM', {}],
    ['PHONE_APP_CHECKER_PLAIN', { TERM: 'xterm-256color', PHONE_APP_CHECKER_PLAIN: '1' }],
  ])('%s: the classic numbered menu, no escape sequence of ours at all', async (_name, env) => {
    // Node's own readline redraws the prompt line with cursor escapes unless the host TERM is "dumb"; that is
    // not ours and depends on the shell running the tests, so pin it. `env` below is what the menu itself sees.
    vi.stubEnv('TERM', 'dumb');
    const tty = fakeTty();
    const { host } = build(tty.io, { env });
    const done = runMenu(host);
    await until(tty, 'Choose 0-6 or L, then Enter: ');
    expect(tty.screen()).toContain('=== Phone App Checker v9.9.9 ===');
    expect(tty.screen()).not.toMatch(/\u001b\[(?!\?)/);
    expect(tty.screen()).not.toContain('╭');
    expect(tty.screen()).not.toMatch(/[✅⬜✔○]/u);
    // The accounts are still shown, in words and ASCII.
    expect(view(tty)).toContain('Accounts ready: [ ] telegram none');
    await tty.send('0\r');
    await done;
  });
});

describe('the menu on a screen grid (what the user actually sees)', () => {
  it.each([
    { columns: 80, rows: 24 },
    { columns: 60, rows: 20 },
    { columns: 40, rows: 12 },
  ])('keeps every line inside the window and leaves no list behind when it closes ($columns x $rows)', async ({ columns, rows }) => {
    const tty = fakeTty({ columns, rows });
    const { host } = build(tty.io, { accounts: { whatsapp: ['default'] } });
    const done = runMenu(host);
    await until(tty, 'q quit');
    const open = screenGrid({ columns, rows });
    open.feed(tty.screen());
    const lines = open.text();
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(columns);
    // The highlighted row and the hint are on screen even when the window is small.
    expect(lines.some((line) => line.startsWith('❯') && line.includes('Check a CSV file'))).toBe(true);
    expect(lines.some((line) => line.includes('q quit'))).toBe(true);

    await tty.send('0');
    await done;
    const closed = screenGrid({ columns, rows });
    closed.feed(tty.screen());
    const snapshot = closed.snapshot();
    expect(snapshot).toContain('Goodbye.');
    expect(snapshot).not.toContain('Log in an app account');
    for (const line of closed.text()) expect(displayWidth(line)).toBeLessThanOrEqual(columns);
  });

  it('the plain tier wraps every line to a narrow window and still shows the accounts status line', async () => {
    vi.stubEnv('TERM', 'dumb');
    const columns = 40;
    const tty = fakeTty({ columns, rows: 24 });
    const { host } = build(tty.io, { env: { NO_COLOR: '1' }, accounts: { telegram: ['a'] } });
    const done = runMenu(host);
    const prompt = await until(tty, 'Choose 0-6 or L, then Enter: ');
    const menu = stripAnsi(tty.screen()).slice(0, stripAnsi(tty.screen()).indexOf('Choose 0-6 or L, then Enter: '));
    for (const line of menu.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(columns - 1);
    expect(view(tty)).toContain('Accounts ready: [ok] telegram 1 account');
    expect(view(tty)).toContain('[ ] whatsapp none');

    await tty.send('5\r');
    const paused = await until(tty, 'Press Enter for the menu.', prompt);
    const guide = stripAnsi(tty.screen()).slice(stripAnsi(tty.screen()).indexOf('GUIDE AND WARNINGS'), stripAnsi(tty.screen()).lastIndexOf('Press Enter for the menu.'));
    expect(guide.length).toBeGreaterThan(100);
    for (const line of guide.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(columns - 1);
    await tty.send('\r');
    await answer(tty, 'Choose 0-6 or L, then Enter: ', '0\r', paused);
    await done;
  });
});

describe('settings', () => {
  it('lists the config in an arrow-key list and Enter on the theme row cycles and saves it', async () => {
    const saved: string[] = [];
    const tty = fakeTty({ columns: 80, rows: 24 });
    const { host } = build(tty.io, { accounts: { telegram: ['a'] }, saveTheme: (theme) => void saved.push(theme) });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '6');
    at = await until(tty, 'Esc, q or b back', at);
    for (const row of ['Theme: Auto', 'Language: English', 'Remember recent files: on', 'Data folder:', 'Config file:']) {
      expect(view(tty)).toContain(row);
    }
    // Enter activates the highlighted theme row: the next mode is applied and saved.
    await tty.send('\r');
    at = await until(tty, 'Theme saved', at);
    expect(saved).toEqual(['dark']);
    expect(view(tty).slice(at)).toContain('Theme: Dark');
    // b goes back to the main menu, 0 quits.
    await tty.send('b');
    await until(tty, 'q quit', at);
    await tty.send('0');
    await done;
  });
});

describe('guide pages', () => {
  it('splits the guide into pages that fit a short window: Enter reads the next page, the last one waits for Enter', async () => {
    const tty = fakeTty({ columns: 80, rows: 14 });
    const { host } = build(tty.io);
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '5');
    at = await until(tty, 'Guide and warnings · page 1 of 2', at);
    const first = view(tty).slice(at);
    expect(first).toContain('agreed to be contacted');
    expect(first).not.toContain('Zalo only checks');
    at = await answer(tty, 'Enter = next page · b back', '\r', at);
    at = await until(tty, 'Guide and warnings · page 2 of 2', at);
    expect(view(tty).slice(at)).toContain('Zalo only checks Vietnamese numbers (+84)');
    at = await answer(tty, 'Press Enter for the menu.', '\r', at);
    await answer(tty, 'q quit', '0', at);
    expect(await done).toBe(0);
  });

  it('b stops after the first page and goes straight back to the menu', async () => {
    const tty = fakeTty({ columns: 80, rows: 14 });
    const { host } = build(tty.io);
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '5');
    at = await answer(tty, 'Enter = next page · b back', 'b\r', at);
    await answer(tty, 'q quit', '0', at);
    expect(await done).toBe(0);
    expect(view(tty)).not.toContain('page 2 of 2');
  });
});

describe('login screens on a rich terminal', () => {
  it('lists the apps as an arrow-key list with their status; Esc goes back without asking anything', async () => {
    const tty = fakeTty();
    const { host, runs } = build(tty.io, { accounts: { telegram: ['a', 'b'] } });
    const done = runMenu(host);
    const at = await answer(tty, 'q quit', '2');
    await until(tty, 'Log in to which app?', at);
    const screen = view(tty);
    expect(screen).toContain('1 telegram: logged in: 2 accounts (a, b)');
    expect(screen).toContain('2 whatsapp: not set up');
    expect(screen).toContain('Esc, q or b back');
    await tty.send(ESC);
    await quitFrom(tty, at);
    await done;
    expect(runs).toEqual([]);
  });

  it('Telegram with keys saved: says "API keys found", skips steps 1 and 2 (no page, no questions) and goes straight to scan', async () => {
    const tty = colourTty();
    const { host, runs, opened } = build(tty.io, { telegram: { apiId: 1234567, apiHash: HASH } });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '1', at);
    const from = at;
    at = await until(tty, '✔ API keys found: steps 1 and 2 are already done.', at);
    const overview = view(tty).slice(from);
    expect(overview).toContain('Log in to Telegram');
    expect(overview).not.toContain('Step 1/3');
    expect(overview).not.toContain('Step 2/3');
    at = await answer(tty, 'Account name (Enter = default, b = back): ', '\r', at);
    await until(tty, 'Step 3/3 - Scan the QR code (or enter phone + code)', at);
    await answer(tty, 'How do you want to log in to Telegram?', '1', at);
    at = await until(tty, 'Next step: choose 1', at);
    await quitFrom(tty, at);
    await done;
    const screen = view(tty);
    expect(screen).not.toContain('my.telegram.org');
    expect(screen).not.toContain('api_id (digits only');
    expect(screen).not.toContain(HASH);
    expect(opened).toEqual([]);
    expect(runs).toEqual([['login', 'telegram', '--account', 'default', '--method', 'qr', ...EN]]);
  });

  it('Telegram without keys: step 1 explains why first, with no overview of the later steps, and the account name is asked inside it', async () => {
    const tty = fakeTty({ columns: 100 });
    const { host } = build(tty.io);
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '1', at);
    const offered = await until(tty, 'in your browser now? (y/N; y = yes, n = no): ', at);
    const beforeFirstQuestion = view(tty).slice(at, offered);
    expect(beforeFirstQuestion).toContain('Log in to Telegram');
    expect(beforeFirstQuestion).toContain('Step 1/3 - Get your free Telegram API keys (one-time)');
    expect(beforeFirstQuestion).toContain('Why keys? Telegram requires them from every program that logs in to Telegram.');
    expect(beforeFirstQuestion).toContain('The QR code appears in Step 3, right after the keys are saved.');
    // No up-front list of the three steps: the later headers appear when their step starts.
    expect(beforeFirstQuestion).not.toContain('Step 2/3');
    expect(beforeFirstQuestion).not.toContain('Step 3/3');
    expect(beforeFirstQuestion).not.toContain('API keys found');
    await tty.send('n\r');
    const named = await until(tty, 'Account name (Enter = default, b = back): ', offered);
    expect(view(tty).slice(offered, named)).not.toContain('Step 2/3');
    await tty.send('\u0003');
    await done;
    expect(view(tty).match(/Step 1\/3/g)).toHaveLength(1);
  });
});

describe('Telegram keys: steps 1 and 2 (text mode on a terminal: the browser offer; plain mode: no offer)', () => {
  const secret = (screen: string): void => {
    expect(screen).not.toContain(HASH);
    expect(screen).not.toContain(HASH.toUpperCase());
  };
  const OFFER = 'in your browser now? (y/N; y = yes, n = no): ';

  it('prints the address and the form guide, offers to open it (default no), and opens exactly that address only after a yes', async () => {
    const tty = fakeTty({ columns: 110 });
    const { host, opened, runs, configFile } = build(tty.io);
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '1', at);
    const offered = await until(tty, OFFER, at);
    const guide = view(tty).slice(at, offered);
    expect(guide).toContain('Step 1/3 - Get your free Telegram API keys (one-time)');
    expect(guide).toContain('1) Open https://my.telegram.org/apps and sign in');
    expect(guide).toContain('App title and Short name can be anything');
    expect(guide).toContain('Platform: Other');
    // Nothing has been opened yet: only a yes does it.
    expect(opened).toEqual([]);
    await tty.send('y\r');
    at = await until(tty, 'Opened in your browser. Come back to this window when you have both values.', offered);
    expect(opened).toEqual([TELEGRAM_APPS_URL]);
    at = await answer(tty, 'Account name (Enter = default, b = back): ', 'tg1\r', at);
    at = await until(tty, 'Step 2/3 - Save the keys', at);
    at = await answer(tty, 'api_id (digits only; b = back): ', 'b\r', at);
    await quitFrom(tty, at);
    await done;
    expect(runs).toEqual([]);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).apps.telegram.options).toEqual({});
  });

  it('Enter at the browser question means no: nothing is opened', async () => {
    const tty = fakeTty({ columns: 110 });
    const { host, opened } = build(tty.io);
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '1', at);
    at = await answer(tty, OFFER, '\r', at);
    at = await answer(tty, 'Account name (Enter = default, b = back): ', 'b\r', at);
    await quitFrom(tty, at);
    await done;
    expect(opened).toEqual([]);
  });

  it('a no never opens anything, and an open that fails says to do it by hand', async () => {
    for (const [reply, openResult] of [['n\r', true], ['y\r', false]] as const) {
      const tty = fakeTty({ columns: 110 });
      const opened: string[] = [];
      const { host } = build(tty.io, {
        openUrl: async (url) => {
          opened.push(url);
          return openResult;
        },
      });
      const done = runMenu(host);
      let at = await answer(tty, 'q quit', '2');
      at = await answer(tty, 'Log in to which app?', '1', at);
      at = await answer(tty, OFFER, reply, at);
      if (reply === 'n\r') {
        expect(opened).toEqual([]);
        expect(view(tty)).not.toContain('Opened in your browser');
      } else {
        at = await until(tty, 'Could not open the browser. Open the address above by hand.', at);
      }
      at = await answer(tty, 'Account name (Enter = default, b = back): ', '\r', at);
      at = await answer(tty, 'api_id (digits only; b = back): ', 'b\r', at);
      await quitFrom(tty, at);
      await done;
    }
  });

  it('never offers the browser (and never calls it) when the terminal is not interactive', async () => {
    // Plain scripted terminal: not a TTY. The address is printed, nobody is asked, nothing is opened.
    const terminal = scriptedTerminal(['2', '1', 'tg1', 'b', '0']);
    const { host, opened, runs } = build(terminal.io, { env: {} });
    await runMenu(host);
    const screen = terminal.screen();
    expect(screen).toContain('https://my.telegram.org/apps');
    expect(screen).not.toContain('in your browser now?');
    expect(opened).toEqual([]);
    expect(runs).toEqual([]);
    expect(terminal.remaining()).toEqual([]);
  });

  it('asks nothing browser-related when the host has no way to open a page', async () => {
    const terminal = scriptedTerminal(['2', '1', 'tg1', 'b', '0'], true);
    const { host } = build(terminal.io, { env: {} });
    delete host.openUrl;
    await runMenu(host);
    expect(terminal.screen()).not.toContain('in your browser now?');
  });

  it('on an interactive terminal (answers typed as lines) it asks first, defaults to no, and "n" skips it', async () => {
    const terminal = scriptedTerminal(['2', '1', 'n', 'tg1', 'b', '0'], true);
    const { host, opened } = build(terminal.io, { env: {} });
    await runMenu(host);
    expect(terminal.screen().replace(/\s+/g, ' ')).toContain('Open https://my.telegram.org/apps in your browser now? (y/N; y = yes, n = no): ');
    expect(opened).toEqual([]);
    expect(terminal.remaining()).toEqual([]);
  });

  it('validates inline with friendly messages: a pasted api_hash in the api_id question, wrong lengths, the id pasted as the hash', async () => {
    const terminal = scriptedTerminal(['2', '1', 'tg1', HASH, 'abc', '1234567', '12345678', '0123abc', 'nothex!!', 'B']);
    const { host, runs } = build(terminal.io, { env: {} });
    await runMenu(host);
    const screen = terminal.screen().replace(/\s+/g, ' ');
    expect(screen).toContain('That looks like the api_hash (the long code). The api_id is the short number shown above it.');
    expect(screen).toContain('The api_id is a number made of digits only, for example 1234567.');
    expect(screen).toContain('That looks like the api_id (the short number). The api_hash is the long 32-character code shown below it.');
    expect(screen).toContain('The api_hash you typed has 7 characters; it needs exactly 32 (0-9 and a-f).');
    expect(screen).toContain('The api_hash is exactly 32 characters made of digits 0-9 and letters a-f.');
    expect(runs).toEqual([]);
    secret(screen);
  });

  it('"b" (any case) goes back at the api_id and at the api_hash question and saves nothing', async () => {
    for (const script of [['2', '1', 'tg1', 'b', '0'], ['2', '1', 'tg1', 'B', '0'], ['2', '1', 'tg1', '1234567', 'b', '0'], ['2', '1', 'tg1', '1234567', 'B', '0']]) {
      const terminal = scriptedTerminal(script);
      const { host, runs, configFile } = build(terminal.io, { env: {} });
      await runMenu(host);
      expect(runs).toEqual([]);
      expect(JSON.parse(readFileSync(configFile, 'utf8')).apps.telegram.options).toEqual({});
      expect(terminal.remaining()).toEqual([]);
    }
  });

  it('masks the api_hash while it is typed (one mask character per key, backspace removes one), then says it was accepted without showing it', async () => {
    const tty = colourTty(110, 60);
    const { host, runs, configFile } = build(tty.io, { openUrl: async () => true });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '1', at);
    at = await answer(tty, OFFER, 'n\r', at);
    at = await answer(tty, 'Account name (Enter = default, b = back): ', '\r', at);
    at = await answer(tty, 'api_id (digits only; b = back): ', '1234567\r', at);
    const promptEnds = await until(tty, 'hidden while you type; b = back): ', at);
    await tty.send(HASH.slice(0, 10));
    await tty.send('\u007f');
    await tty.send(HASH.slice(9));
    const typed = view(tty).slice(promptEnds);
    expect(typed.startsWith('•'.repeat(10))).toBe(true);
    expect(typed).toContain('\b \b');
    expect(typed).not.toContain(HASH.slice(0, 10));
    await tty.send('\r');
    await until(tty, 'api_hash accepted (32 characters, kept hidden).', promptEnds);
    await until(tty, `api_id and api_hash saved in ${configFile}`, promptEnds);
    await until(tty, 'Step 3/3 - Scan the QR code (or enter phone + code)', promptEnds);
    await answer(tty, 'How do you want to log in to Telegram?', '1', promptEnds);
    at = await until(tty, 'Next step: choose 1', promptEnds);
    await quitFrom(tty, at);
    await done;
    secret(view(tty));
    expect(JSON.parse(readFileSync(configFile, 'utf8')).apps.telegram.options).toEqual({ apiId: 1234567, apiHash: HASH });
    expect(runs).toEqual([['login', 'telegram', '--account', 'default', '--method', 'qr', ...EN]]);
  });
});

describe('login method list and the closing box on a rich terminal', () => {
  it('WhatsApp method: an arrow-key list with a detail line under each method, no "1)" numbering; Esc goes back without running anything', async () => {
    const tty = colourTty(110, 60);
    const { host, runs } = build(tty.io);
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '2', at);
    at = await answer(tty, 'Account name (Enter = default, b = back): ', '\r', at);
    await until(tty, 'Step 2/2 - Link the account', at);
    await until(tty, 'How do you want to link WhatsApp?', at);
    const screen = view(tty);
    expect(screen).toContain('❯ 1 Link with your phone number: type an 8-character code on your phone (recommended)');
    expect(screen).toContain('On the phone: WhatsApp > Settings > Linked devices > Link with phone number');
    expect(screen).toContain('2 Scan a QR code with your phone');
    // The QR method says up front what window it needs.
    expect(screen).toMatch(/Needs a window of at least \d+ x \d+/);
    await tty.send(ESC);
    await quitFrom(tty, at);
    await done;
    expect(runs).toEqual([]);
  });

  it('a finished check ends in a "Report saved to" box with the next steps; incomplete runs get a prominent warning; the file just used is offered again', async () => {
    const csv = join(work, 'customers.csv');
    writeFileSync(csv, CSV);
    const out = join(work, 'report.csv');
    const tty = fakeTty({ columns: 120 });
    const { host, runs } = build(tty.io, {
      accounts: { telegram: ['a'] },
      results: [{ code: 0, report: { path: out, inconclusive: 0 } }, { code: 0, report: { path: out, inconclusive: 7 } }],
    });
    const done = runMenu(host);
    let at = await chooseCsv(tty, csv);
    at = await answer(tty, 'Report file (Enter = ', '\r', at);
    await until(tty, '╭─ Report saved to', at);
    let box = view(tty).slice(at);
    // The path is long (a temp folder): the title and the Finder hint cut it from the left, keeping the file name.
    expect(box).toMatch(/╭─ Report saved to [^ ]*report\.csv ─/);
    expect(box).toContain('│ Next: open the file with Excel or Numbers (double-click it).');
    expect(box).toMatch(/│ To show it in Finder, type: open -R '[^ ]*report\.csv'/);
    expect(box).not.toContain('INCOMPLETE');
    // The check ends in a pause: Enter returns to the menu.
    await tty.send('\r');
    // Second run: the menu is back and the file just used is the first choice on the list; 7 numbers are still without an answer.
    at = await until(tty, 'Accounts ready:', at);
    at = await answer(tty, '↑↓ move · Enter select', '1', at);
    at = await answer(tty, 'Choose the phone list (CSV)', '1', at);
    expect(view(tty).slice(at)).toContain('customers.csv');
    at = await answer(tty, 'Use this file? (Enter = continue, b = pick another): ', '\r', at);
    at = await answer(tty, 'Report file (Enter = ', '\r', at);
    // (the fake command writes no file, so no overwrite question comes up)
    // The box wraps long sentences at the window width; each continuation line starts with the box bar.
    await until(tty, 'INCOMPLETE: the report is NOT final.', at);
    await until(tty, 'Numbers without a', at);
    box = view(tty).slice(at).replaceAll('│ ', '');
    expect(box).toContain('Numbers without a fresh answer: 7.');
    expect(box).toContain('Run the same check again with the same file to continue; finished numbers are not repeated.');
    // The warning is bold red on a rich terminal.
    expect(tty.screen()).toMatch(/\u001b\[31m\u001b\[1m[^\n]*INCOMPLETE/);
    await tty.send('\r'); // the pause after the box
    await quitFrom(tty, at);
    await done;
    expect(runs.map((run) => run[0])).toEqual(['check', 'check']);
  });

  it('truncates a very long report path from the left in the box instead of wrapping it', async () => {
    const csv = join(work, 'customers.csv');
    writeFileSync(csv, CSV);
    const long = join(work, 'very', 'long', 'folder', 'name', 'that', 'goes', 'on', 'and', 'on', 'for', 'a', 'while', 'report.csv');
    const tty = fakeTty({ columns: 60 });
    const { host } = build(tty.io, { accounts: { telegram: ['a'] }, results: [{ code: 0, report: { path: long, inconclusive: 0 } }] });
    const done = runMenu(host);
    let at = await chooseCsv(tty, csv);
    at = await answer(tty, 'Report file (Enter = ', '\r', at);
    await until(tty, '╭─ Report saved to', at);
    const raw = stripAnsi(tty.screen());
    const lines = raw
      .slice(raw.lastIndexOf('╭─ Report saved to'))
      .split('\n')
      .slice(0, 5)
      .map((line) => line.split('\r')[0] as string);
    expect(lines[0]).toMatch(/^╭─ Report saved to …/);
    expect(lines[0]).toContain('report.csv');
    for (const line of lines) expect([...line].length).toBeLessThanOrEqual(59);
    await tty.send('\r'); // the pause after the box
    await answer(tty, 'q quit', '0', at);
    await done;
  });
});

describe('the file step: recent files, preview, app checklist', () => {
  const seed = (...names: string[]): string[] => {
    const recent = openRecentFiles(join(dir, 'data'));
    const paths = names.map((name) => {
      const path = join(work, name);
      writeFileSync(path, CSV);
      return path;
    });
    for (const path of paths) recent?.add(path);
    return paths;
  };

  it('offers the last files used before asking for a path: a number picks one, and a file that vanished is greyed and cannot be picked', async () => {
    const [a, b] = seed('a.csv', 'b.csv') as [string, string]; // newest first: b, a
    rmSync(a);
    const tty = fakeTty({ columns: 100 });
    const { host, runs } = build(tty.io, { accounts: { telegram: ['x'] } });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '1');
    at = await until(tty, 'Choose the phone list (CSV)', at);
    const picker = view(tty).slice(at);
    expect(picker).toContain('1 b.csv');
    expect(picker).toContain('2 a.csv');
    expect(picker).toContain('missing');
    expect(picker).toContain('Type or paste a path');
    await tty.send('2'); // the vanished file: nothing happens
    await tty.send('1');
    at = await answer(tty, 'Use this file? (Enter = continue, b = pick another): ', '\r', at);
    at = await answer(tty, 'Report file (Enter = ', '\r', at);
    await quitFrom(tty, at);
    await done;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.at(-1)).toBe(b);
  });

  it('c clears the list and stops remembering, after a confirmation; a path can still be typed', async () => {
    seed('a.csv');
    const tty = fakeTty({ columns: 100 });
    const { host, runs } = build(tty.io, { accounts: { telegram: ['x'] } });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '1');
    at = await answer(tty, 'Choose the phone list (CSV)', 'c', at);
    at = await answer(tty, 'Clear the recent files and stop remembering them? (y/N; y = yes, n = no): ', 'y\r', at);
    at = await until(tty, 'Recent files cleared; remembering is now off.', at);
    at = await answer(tty, 'CSV file (b = back): ', 'b\r', at);
    await quitFrom(tty, at);
    await done;
    expect(runs).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'data', 'recent-files.json'), 'utf8'))).toEqual({ enabled: false, files: [] });
  });

  it('Esc at the list goes back to the menu without asking for a path', async () => {
    seed('a.csv');
    const tty = fakeTty({ columns: 100 });
    const { host, runs } = build(tty.io, { accounts: { telegram: ['x'] } });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '1');
    at = await answer(tty, 'Choose the phone list (CSV)', ESC, at);
    await quitFrom(tty, at);
    await done;
    expect(runs).toEqual([]);
    expect(view(tty)).not.toContain('CSV file (b = back)');
  });

  it('previews the file before the run (rows, usable, unusable, countries) and b goes back to choosing', async () => {
    const csv = join(work, 'mixed.csv');
    writeFileSync(csv, 'name,phone\nAn,0901234567\nBinh,+65 9123 4567\nCuong,abc\n');
    const tty = fakeTty({ columns: 100 });
    const { host, runs } = build(tty.io, { accounts: { telegram: ['a'] } });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '1');
    at = await answer(tty, 'CSV file (b = back): ', `${csv}\r`, at);
    at = await until(tty, 'Use this file? (Enter = continue, b = pick another): ', at);
    const preview = view(tty).slice(0, at);
    expect(preview).toContain('mixed.csv · phone column "phone"');
    expect(preview).toContain('3 rows · 2 usable numbers · 1 unusable');
    expect(preview).toContain('Unusable, for example: "abc" (kept in the report)');
    expect(preview).toContain('Countries: VN 1 · SG 1');
    expect(runs).toEqual([]);
    await tty.send('b\r');
    at = await answer(tty, 'CSV file (b = back): ', 'b\r', at);
    await quitFrom(tty, at);
    await done;
    expect(runs).toEqual([]);
  });

  it('the app checklist starts with every logged-in app ticked; Space unticks one, Enter runs the rest, in list order', async () => {
    const csv = join(work, 'customers.csv');
    writeFileSync(csv, CSV);
    const tty = fakeTty({ columns: 100 });
    const { host, runs } = build(tty.io, { accounts: { telegram: ['a'], whatsapp: ['w'], zalo: ['z'] } });
    const done = runMenu(host);
    let at = await chooseCsv(tty, csv);
    at = await until(tty, 'Which apps?', at);
    const list = view(tty).slice(at);
    for (const app of ['telegram', 'whatsapp', 'zalo']) expect(list).toContain(`[x] ${app}`);
    await tty.send(' ');
    await tty.send('\r');
    at = await answer(tty, 'Report file (Enter = ', '\r', at);
    await quitFrom(tty, at);
    await done;
    expect(runs).toEqual([['check', '--out', join(work, 'report.csv'), '--apps', 'whatsapp,zalo', '--', csv]]);
  });

  it('Enter with nothing ticked asks again instead of starting an empty run', async () => {
    const csv = join(work, 'customers.csv');
    writeFileSync(csv, CSV);
    const tty = fakeTty({ columns: 100 });
    const { host, runs } = build(tty.io, { accounts: { telegram: ['a'], whatsapp: ['w'] } });
    const done = runMenu(host);
    let at = await chooseCsv(tty, csv);
    at = await until(tty, 'Which apps?', at);
    await tty.send(` ${DOWN} \r`); // untick both, then Enter
    at = await until(tty, 'Tick at least one app with the space bar.', at);
    at = await until(tty, 'Which apps?', at);
    await tty.send('\r'); // the list is back with everything ticked
    at = await answer(tty, 'Report file (Enter = ', '\r', at);
    await quitFrom(tty, at);
    await done;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.[4]).toBe('telegram,whatsapp');
  });

  it('b at the checklist goes back without running anything', async () => {
    const csv = join(work, 'customers.csv');
    writeFileSync(csv, CSV);
    const tty = fakeTty({ columns: 100 });
    const { host, runs } = build(tty.io, { accounts: { telegram: ['a'], whatsapp: ['w'] } });
    const done = runMenu(host);
    let at = await chooseCsv(tty, csv);
    at = await answer(tty, 'Which apps?', 'b', at);
    await quitFrom(tty, at);
    await done;
    expect(runs).toEqual([]);
  });
});

describe('QR window check before a QR login', () => {
  /** WhatsApp, QR method, in a window of the given size: stops at the "enlarge the window" question. */
  async function toGate(columns: number, rows: number) {
    const tty = colourTty(columns, rows);
    const setup = build(tty.io);
    const done = runMenu(setup.host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '2', at);
    at = await answer(tty, 'Account name (Enter = default, b = back): ', '\r', at);
    at = await answer(tty, 'How do you want to link WhatsApp?', '2', at);
    const asked = await until(tty, 'Enlarge the window, then press Enter to try again', at);
    return { tty, ...setup, done, at, asked };
  }

  it('says the window is too small and the size it needs before anything is started, and runs nothing yet', async () => {
    const { tty, runs, done, at, asked } = await toGate(80, 24);
    const message = view(tty).slice(at, asked);
    const size = /This window is 80 x 24; the code needs (\d+) x (\d+)\./.exec(message);
    expect(size).not.toBeNull();
    expect(Number(size?.[2])).toBeGreaterThan(24);
    expect(message).toContain('Cmd+minus');
    expect(runs).toEqual([]);
    await tty.send('b\r');
    await quitFrom(tty, asked);
    await done;
  });

  it('b stops the login: nothing is run and the menu comes back', async () => {
    const { tty, runs, done, asked } = await toGate(80, 24);
    await tty.send('b\r');
    await quitFrom(tty, asked);
    await done;
    expect(runs).toEqual([]);
  });

  it('c switches to the pairing code, which asks for the phone number', async () => {
    const { tty, runs, done, asked } = await toGate(80, 24);
    expect(view(tty).slice(asked - 120)).toContain('type c to use the pairing code instead');
    await tty.send('c\r');
    const phone = await until(tty, 'Phone number of the WhatsApp account you are linking', asked);
    await tty.send('0901234567\r');
    const next = await until(tty, 'Next step: choose 1', phone);
    await quitFrom(tty, next);
    await done;
    expect(runs).toEqual([['login', 'whatsapp', '--account', 'default', '--method', 'code', '--phone', '+84901234567', ...EN]]);
  });

  it('Enter checks the window again: once it has been enlarged the QR login starts', async () => {
    const { tty, runs, done, asked } = await toGate(80, 24);
    await tty.send('\r'); // still too small: asked again, nothing started
    const again = await until(tty, 'Enlarge the window, then press Enter to try again', asked);
    expect(runs).toEqual([]);
    resize(tty, 140, 80);
    await tty.send('\r');
    const next = await until(tty, 'Next step: choose 1', again);
    await quitFrom(tty, next);
    await done;
    expect(runs).toEqual([['login', 'whatsapp', '--account', 'default', '--method', 'qr', ...EN]]);
  });

  it('an app with only a QR login (Zalo) offers no alternative, only a retry or back', async () => {
    const tty = colourTty(80, 24);
    const { host, runs } = build(tty.io);
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '3', at);
    at = await answer(tty, 'Account name (Enter = default, b = back): ', '\r', at);
    const asked = await until(tty, 'Enlarge the window, then press Enter to try again (b = back): ', at);
    expect(view(tty).slice(at, asked)).not.toContain('type c to');
    await tty.send('b\r');
    await quitFrom(tty, asked);
    await done;
    expect(runs).toEqual([]);
  });
});

describe('accounts view with actions', () => {
  it('lists the accounts as an arrow list; r resets the cooldown of the highlighted account, b goes back', async () => {
    const tty = fakeTty({ columns: 100 });
    const { host, runs } = build(tty.io, { accounts: { telegram: ['a', 'b'] } });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '3');
    at = await until(tty, 'r reset cooldown · l log in again · b back', at);
    expect(view(tty)).toContain('telegram: a');
    expect(view(tty)).toContain('telegram: b');
    await tty.send(DOWN);
    await tty.send('r');
    await settle(() => runs.length === 2);
    expect(runs).toEqual([['accounts'], ['account-reset', 'telegram', 'b']]);
    await tty.send('b'); // the list is open again after the reset
    await quitFrom(tty, at);
    await done;
    expect(runs).toHaveLength(2);
  });

  it('Enter on an account logs it in again, after asking before replacing the old session', async () => {
    const tty = colourTty();
    const { host, runs } = build(tty.io, { accounts: { zalo: ['z'] } });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '3');
    at = await answer(tty, 'r reset cooldown', '\r', at);
    at = await answer(tty, 'Log in again anyway? (y/N; y = yes, n = no): ', 'y\r', at);
    await settle(() => runs.length === 2);
    expect(runs[1]).toEqual(['login', 'zalo', '--account', 'z', ...EN]);
    await quitFrom(tty, at);
    await done;
  });

  it('l starts a login for a new account of the highlighted app', async () => {
    const tty = colourTty();
    const { host, runs } = build(tty.io, { accounts: { zalo: ['z'] } });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '3');
    at = await answer(tty, 'r reset cooldown', 'l', at);
    at = await answer(tty, 'Account name (Enter = default, b = back): ', 'z2\r', at);
    await settle(() => runs.length === 2);
    expect(runs[1]).toEqual(['login', 'zalo', '--account', 'z2', ...EN]);
    await quitFrom(tty, at);
    await done;
  });
});
