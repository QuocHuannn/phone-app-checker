import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { saveTelegramCredentials } from '../src/config-write.ts';
import { runMenu, type CommandResult, type MenuHost } from '../src/menu.ts';
import { TELEGRAM_APPS_URL } from '../src/open-url.ts';
import type { App } from '../src/types.ts';
import { stripAnsi } from '../src/ui.ts';
import { fakeTty, type FakeTty } from './helpers/fake-tty.ts';
import { scriptedTerminal } from './helpers/menu-io.ts';

const ESC = '\u001b';
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;
const RICH_ENV = { TERM: 'xterm-256color' };
const HASH = '0123456789abcdef0123456789abcdef';
const EN = ['--lang', 'en'];

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
  };
  return { host, runs, opened, configFile };
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
  throw new Error(`never saw ${JSON.stringify(text)} on screen:\n${view(tty)}`);
}

/** Wait for `text`, then send `keys`; returns the screen position after `text` for the next wait. */
async function answer(tty: FakeTty, text: string, keys: string, from = 0): Promise<number> {
  const at = await until(tty, text, from);
  await tty.send(keys);
  return at;
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
    expect(screen).toContain('⬜ telegram – · ✅ whatsapp 1 · ⬜ zalo – · ⬜ viber – · ⬜ line –');
    expect(screen).toContain('⬜ telegram –');
    for (const row of ['1 🔍 Check a CSV file', '2 🔑 Log in an app account', '3 👤 View logged-in accounts', '6 📖 Guide / warnings', '0 🚪 Quit']) {
      expect(screen).toContain(row);
    }
    expect(screen).toContain('L 🌐 Language / Ngôn ngữ / Bahasa / 언어 / 语言: English');
    expect(screen).toContain('❯ 1 🔍 Check a CSV file');
    await tty.send('0');
    expect(await done).toBe(0);
    expect(tty.rawModes.at(-1)).toBe(false);
  });

  it('navigates with the arrow keys and Enter: ↓↓ then Enter opens item 3 (accounts), q quits', async () => {
    const tty = fakeTty();
    const { host, runs } = build(tty.io, { accounts: { telegram: ['a'] }, results: [{ code: 0 }] });
    const done = runMenu(host);
    await answer(tty, 'q quit', `${DOWN}${DOWN}\r`);
    await until(tty, '› 👤 View logged-in accounts');
    await tty.send('q');
    expect(await done).toBe(0);
    expect(runs).toEqual([['accounts']]);
    expect(view(tty)).toContain('Goodbye.');
  });

  it('↑ from the first row wraps to the last (Quit); Esc also quits', async () => {
    const tty = fakeTty();
    const { host } = build(tty.io);
    const done = runMenu(host);
    await answer(tty, 'q quit', UP);
    await until(tty, '❯ 0 🚪 Quit');
    await tty.send(ESC);
    expect(await done).toBe(0);
    expect(view(tty)).toContain('Goodbye.');
  });

  it('number keys pick at once: 6 shows the guide in a box, then 0 quits', async () => {
    const tty = fakeTty();
    const { host, runs } = build(tty.io);
    const done = runMenu(host);
    const at = await answer(tty, 'q quit', '6');
    await until(tty, '╭─ GUIDE AND WARNINGS', at);
    const screen = view(tty);
    expect(screen).toContain('│ - Only check numbers of people who agreed to be contacted.');
    await answer(tty, 'q quit', '0', at);
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
    await until(tty, 'Choose (0-6 or L) and press Enter: ');
    const screen = view(tty);
    expect(screen).toContain('╭─ Phone App Checker v9.9.9');
    expect(screen).toContain(' 1. Check a CSV file');
    expect(screen).not.toContain('↑↓ move');
    await tty.send('0\r');
    expect(await done).toBe(0);
  });

  it.each([
    ['NO_COLOR', { TERM: 'xterm-256color', NO_COLOR: '1' }],
    ['TERM=dumb', { TERM: 'dumb' }],
    ['no TERM', {}],
  ])('%s: the classic numbered menu, no escape sequence of ours at all', async (_name, env) => {
    // Node's own readline redraws the prompt line with cursor escapes unless the host TERM is "dumb"; that is
    // not ours and depends on the shell running the tests, so pin it. `env` below is what the menu itself sees.
    vi.stubEnv('TERM', 'dumb');
    const tty = fakeTty();
    const { host } = build(tty.io, { env });
    const done = runMenu(host);
    await until(tty, 'Choose (0-6 or L) and press Enter: ');
    expect(tty.screen()).toContain('=== Phone App Checker v9.9.9 ===');
    expect(tty.screen()).not.toMatch(/\u001b\[(?!\?)/);
    expect(tty.screen()).not.toContain('╭');
    expect(tty.screen()).not.toContain('✅');
    await tty.send('0\r');
    await done;
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
    expect(screen).toContain('Esc or q back');
    await tty.send(ESC);
    await answer(tty, 'q quit', '0', at);
    await done;
    expect(runs).toEqual([]);
  });

  it('Telegram with keys saved: says "API keys found", skips steps 1 and 2 (no page, no questions) and goes straight to scan', async () => {
    const tty = fakeTty({ columns: 100 });
    const { host, runs, opened } = build(tty.io, { telegram: { apiId: 1234567, apiHash: HASH } });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '1', at);
    await until(tty, 'API keys found: steps 1 and 2 are already done.', at);
    const overview = view(tty);
    expect(overview).toContain('✔ Step 1/3 - Get your free Telegram API keys (one-time)');
    expect(overview).toContain('✔ Step 2/3 - Save the keys');
    expect(overview).toContain('Step 3/3 - Scan the QR code (or enter phone + code)');
    at = await answer(tty, 'Account name (Enter = default): ', '\r', at);
    await until(tty, 'Step 3/3 - Scan the QR code (or enter phone + code)', at);
    await until(tty, 'How do you want to log in to Telegram?', at);
    await tty.send('1');
    await until(tty, 'Next step: choose 1', at);
    await tty.send('0');
    await done;
    const screen = view(tty);
    expect(screen).not.toContain('my.telegram.org');
    expect(screen).not.toContain('api_id (digits only');
    expect(screen).not.toContain(HASH);
    expect(opened).toEqual([]);
    expect(runs).toEqual([['login', 'telegram', '--account', 'default', '--method', 'qr', ...EN]]);
  });

  it('Telegram without keys: the stepper and the reason come first, before any question', async () => {
    const tty = fakeTty({ columns: 100 });
    const { host } = build(tty.io);
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '1', at);
    const asked = await until(tty, 'Account name (Enter = default): ', at);
    const beforeFirstQuestion = view(tty).slice(at, asked);
    expect(beforeFirstQuestion).toContain('Step 1/3 - Get your free Telegram API keys (one-time)');
    expect(beforeFirstQuestion).toContain('Step 2/3 - Save the keys');
    expect(beforeFirstQuestion).toContain('Step 3/3 - Scan the QR code (or enter phone + code)');
    expect(beforeFirstQuestion).toContain('Why keys? Telegram requires them from every program that logs in to Telegram.');
    expect(beforeFirstQuestion).toContain('The QR code appears in Step 3, right after the keys are saved.');
    expect(beforeFirstQuestion).not.toContain('API keys found');
    await tty.send('\u0003');
    await done;
  });
});

describe('Telegram keys: steps 1 and 2 (text mode on a terminal: the browser offer; plain mode: no offer)', () => {
  const secret = (screen: string): void => {
    expect(screen).not.toContain(HASH);
    expect(screen).not.toContain(HASH.toUpperCase());
  };

  it('prints the address and the form guide, offers to open it, and opens exactly that address only after a yes', async () => {
    const tty = fakeTty({ columns: 110 });
    const { host, opened, runs, configFile } = build(tty.io);
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '1', at);
    at = await answer(tty, 'Account name (Enter = default): ', 'tg1\r', at);
    await until(tty, 'Open https://my.telegram.org/apps in your browser now? (Y/n; y = yes, n = no): ', at);
    const guide = view(tty).slice(at);
    expect(guide).toContain('Step 1/3 - Get your free Telegram API keys (one-time)');
    expect(guide).toContain('1) Open https://my.telegram.org/apps and sign in');
    expect(guide).toContain('App title and Short name can be anything');
    expect(guide).toContain('Platform: Other');
    // Nothing has been opened yet: only a yes does it.
    expect(opened).toEqual([]);
    at = await answer(tty, 'in your browser now? (Y/n; y = yes, n = no): ', 'y\r', at);
    await until(tty, 'Opened in your browser. Come back to this window when you have both values.', at);
    expect(opened).toEqual([TELEGRAM_APPS_URL]);
    await until(tty, 'Step 2/3 - Save the keys', at);
    await until(tty, 'api_id (digits only; b = back): ', at);
    await tty.send('b\r');
    await until(tty, 'q quit', at);
    await tty.send('0');
    await done;
    expect(runs).toEqual([]);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).apps.telegram.options).toEqual({});
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
      at = await answer(tty, 'Account name (Enter = default): ', '\r', at);
      at = await answer(tty, 'in your browser now? (Y/n; y = yes, n = no): ', reply, at);
      if (reply === 'n\r') {
        await until(tty, 'api_id (digits only; b = back): ', at);
        expect(opened).toEqual([]);
        expect(view(tty)).not.toContain('Opened in your browser');
      } else {
        await until(tty, 'Could not open the browser. Open the address above by hand.', at);
      }
      await tty.send('b\r');
      await until(tty, 'q quit', at);
      await tty.send('0');
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

  it('on an interactive terminal (answers typed as lines) it asks first, and "n" skips it', async () => {
    const terminal = scriptedTerminal(['2', '1', 'tg1', 'n', 'b', '0'], true);
    const { host, opened } = build(terminal.io, { env: {} });
    await runMenu(host);
    expect(terminal.screen()).toContain('Open https://my.telegram.org/apps in your browser now? (Y/n; y = yes, n = no): ');
    expect(opened).toEqual([]);
    expect(terminal.remaining()).toEqual([]);
  });

  it('validates inline with friendly messages: a pasted api_hash in the api_id question, wrong lengths, the id pasted as the hash', async () => {
    const terminal = scriptedTerminal(['2', '1', 'tg1', HASH, 'abc', '1234567', '12345678', '0123abc', 'nothex!!', 'B']);
    const { host, runs } = build(terminal.io, { env: {} });
    await runMenu(host);
    const screen = terminal.screen();
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
    const tty = fakeTty({ columns: 110 });
    const { host, runs, configFile } = build(tty.io, { openUrl: async () => true });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '1', at);
    at = await answer(tty, 'Account name (Enter = default): ', '\r', at);
    at = await answer(tty, 'in your browser now? (Y/n; y = yes, n = no): ', 'n\r', at);
    at = await answer(tty, 'api_id (digits only; b = back): ', '1234567\r', at);
    await until(tty, 'api_hash (32 characters 0-9 and a-f, hidden while you type; b = back): ', at);
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
    await until(tty, `api_id and api_hash saved in ${configFile} (the api_hash is not shown).`, promptEnds);
    await until(tty, 'Step 3/3 - Scan the QR code (or enter phone + code)', promptEnds);
    await until(tty, 'How do you want to log in to Telegram?', promptEnds);
    await tty.send('1');
    await until(tty, 'Next step: choose 1', promptEnds);
    await tty.send('0');
    await done;
    secret(view(tty));
    expect(JSON.parse(readFileSync(configFile, 'utf8')).apps.telegram.options).toEqual({ apiId: 1234567, apiHash: HASH });
    expect(runs).toEqual([['login', 'telegram', '--account', 'default', '--method', 'qr', ...EN]]);
  });
});

describe('login method list and the closing box on a rich terminal', () => {
  it('WhatsApp method: an arrow-key list without the "1)" numbering; Esc goes back without running anything', async () => {
    const tty = fakeTty({ columns: 110 });
    const { host, runs } = build(tty.io);
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '2');
    at = await answer(tty, 'Log in to which app?', '2', at);
    at = await answer(tty, 'Account name (Enter = default): ', '\r', at);
    await until(tty, 'Step 2/2 - Link the account', at);
    await until(tty, 'How do you want to link WhatsApp?', at);
    const screen = view(tty);
    expect(screen).toContain('❯ 1 Link with your phone number: type an 8-character code on your phone (recommended)');
    expect(screen).toContain('2 Scan a QR code with your phone');
    await tty.send(ESC);
    await until(tty, 'q quit', at);
    await tty.send('0');
    await done;
    expect(runs).toEqual([]);
  });

  it('a finished check ends in a "Report saved to" box with the next steps; incomplete runs get a prominent warning', async () => {
    const csv = join(work, 'customers.csv');
    writeFileSync(csv, 'name,phone\nAn,0901234567\n');
    const out = join(work, 'report.csv');
    const tty = fakeTty({ columns: 120 });
    const { host, runs } = build(tty.io, {
      accounts: { telegram: ['a'] },
      results: [{ code: 0, report: { path: out, inconclusive: 0 } }, { code: 0, report: { path: out, inconclusive: 7 } }],
    });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '1');
    at = await answer(tty, 'CSV file (Enter to go back): ', `${csv}\r`, at);
    at = await answer(tty, 'Report file (Enter = ', '\r', at);
    await until(tty, '╭─ Report saved to', at);
    let box = view(tty).slice(at);
    // The path is long (a temp folder): the title and the Finder hint cut it from the left, keeping the file name.
    expect(box).toMatch(/╭─ Report saved to [^ ]*report\.csv ─/);
    expect(box).toContain('│ Next: open the file with Excel or Numbers (double-click it).');
    expect(box).toMatch(/│ To show it in Finder, type: open -R '[^ ]*report\.csv'/);
    expect(box).not.toContain('INCOMPLETE');
    // Second run: the menu is back (its banner is printed once per round), and 7 numbers are still without an answer.
    at = await until(tty, 'Accounts ready:', at);
    at = await answer(tty, '↑↓ move · Enter select', '1', at);
    at = await answer(tty, 'CSV file (Enter to go back): ', `${csv}\r`, at);
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
    at = await until(tty, 'Accounts ready:', at);
    await answer(tty, '↑↓ move · Enter select', '0', at);
    await done;
    expect(runs.map((run) => run[0])).toEqual(['check', 'check']);
  });

  it('truncates a very long report path from the left in the box instead of wrapping it', async () => {
    const csv = join(work, 'customers.csv');
    writeFileSync(csv, 'name,phone\nAn,0901234567\n');
    const long = join(work, 'very', 'long', 'folder', 'name', 'that', 'goes', 'on', 'and', 'on', 'for', 'a', 'while', 'report.csv');
    const tty = fakeTty({ columns: 60 });
    const { host } = build(tty.io, { accounts: { telegram: ['a'] }, results: [{ code: 0, report: { path: long, inconclusive: 0 } }] });
    const done = runMenu(host);
    let at = await answer(tty, 'q quit', '1');
    at = await answer(tty, 'CSV file (Enter to go back): ', `${csv}\r`, at);
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
    await answer(tty, 'q quit', '0', at);
    await done;
  });
});
