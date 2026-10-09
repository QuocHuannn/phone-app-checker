import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli.ts';
import { loadConfig } from '../src/config.ts';
import { saveTelegramCredentials } from '../src/config-write.ts';
import { DOCTOR_FOOTER } from '../src/doctor.ts';
import { LANGS, LANGUAGE_LABEL, LANGUAGE_NAMES, translate, type Lang, type MessageArgs, type MessageKey } from '../src/i18n/index.ts';
import { isInteractive, normalizeDroppedPath, parseYesNo, runMenu, type CommandResult, type MenuHost } from '../src/menu.ts';
import { APPS, type Adapter, type App } from '../src/types.ts';
import { scriptedTerminal, type ScriptedTerminal } from './helpers/menu-io.ts';

const REPO = resolve(import.meta.dirname, '..');
const CSV = ['name,phone', 'An,0901234567', 'Binh,+65 9123 4567', ''].join('\n');

let dir: string;
let work: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pac-menu-'));
  work = join(dir, 'work');
  mkdirSync(work);
  writeFileSync(join(work, 'customers.csv'), CSV);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  host: MenuHost;
  runs: string[][];
  screen: () => string;
  /** Screen with every run of whitespace folded to one space, so wrapped sentences still match. */
  flat: () => string;
  remaining: () => string[];
}

/** A menu host over a scripted terminal; `accounts` are session directories that already exist. */
function fixture(
  answers: string[],
  options: {
    accounts?: Partial<Record<App, string[]>>;
    telegram?: { apiId: number; apiHash: string };
    results?: CommandResult[];
    loadConfig?: MenuHost['loadConfig'];
    host?: Partial<MenuHost>;
  } = {},
): Fixture {
  const dataDir = join(dir, 'data');
  for (const [app, names] of Object.entries(options.accounts ?? {})) {
    for (const name of names ?? []) mkdirSync(join(dataDir, 'sessions', app, name), { recursive: true });
  }
  const configFile = join(dir, 'config.json');
  writeFileSync(
    configFile,
    JSON.stringify({ dataDir, apps: { telegram: { options: options.telegram === undefined ? {} : options.telegram } } }),
  );
  const terminal = scriptedTerminal(answers);
  const runs: string[][] = [];
  const results = [...(options.results ?? [])];
  const host: MenuHost = {
    io: terminal.io,
    version: 'v9.9.9',
    cwd: work,
    homeDir: '/home/tester',
    env: {},
    loadConfig: options.loadConfig ?? (() => loadConfig(configFile)),
    configFile: () => configFile,
    saveTelegramCredentials: (apiId, apiHash) => saveTelegramCredentials(configFile, apiId, apiHash),
    run: async (args) => {
      runs.push(args);
      return results.shift() ?? { code: 0 };
    },
    ...options.host,
  };
  return { host, runs, screen: terminal.screen, flat: () => terminal.screen().replace(/\s+/g, ' '), remaining: terminal.remaining };
}

const CSV_PATH = () => join(work, 'customers.csv');

describe('normalizeDroppedPath', () => {
  const home = '/Users/boss';
  const cwd = '/work/dir';
  const cases: [string, string, string | undefined][] = [
    ['plain absolute', '/Users/boss/data.csv', '/Users/boss/data.csv'],
    ['trailing space added by Terminal drag', '/Users/boss/data.csv ', '/Users/boss/data.csv'],
    ['leading and trailing blanks', '  \t/Users/boss/data.csv \t', '/Users/boss/data.csv'],
    ['backslash-escaped spaces', '/Users/boss/My\\ Customers\\ 2026.csv ', '/Users/boss/My Customers 2026.csv'],
    ['escaped parentheses and apostrophe', "/Users/boss/List\\ \\(1\\)\\ Bob\\'s.csv", "/Users/boss/List (1) Bob's.csv"],
    ['single quotes', "'/Users/boss/My Customers.csv'", '/Users/boss/My Customers.csv'],
    ['single quotes keep backslashes literally', "'/Users/boss/a\\b.csv'", '/Users/boss/a\\b.csv'],
    ['double quotes', '"/Users/boss/My Customers.csv"', '/Users/boss/My Customers.csv'],
    ['double quotes with escaped quote', '"/Users/boss/say \\"hi\\".csv"', '/Users/boss/say "hi".csv'],
    ['quoted with trailing space', "'/Users/boss/My Customers.csv' ", '/Users/boss/My Customers.csv'],
    ['file URL', 'file:///Users/boss/data.csv', '/Users/boss/data.csv'],
    ['file URL with percent escapes', 'file:///Users/boss/My%20Customers%20%28v2%29.csv', '/Users/boss/My Customers (v2).csv'],
    ['file URL with localhost host', 'file://localhost/Users/boss/data.csv', '/Users/boss/data.csv'],
    ['file URL, Vietnamese name', 'file:///Users/boss/Kh%C3%A1ch%20h%C3%A0ng.csv', '/Users/boss/Khách hàng.csv'],
    ['quoted file URL', "'file:///Users/boss/data.csv'", '/Users/boss/data.csv'],
    ['tilde', '~/Downloads/data.csv', '/Users/boss/Downloads/data.csv'],
    ['tilde with escaped spaces', '~/My\\ Files/data.csv', '/Users/boss/My Files/data.csv'],
    ['bare tilde', '~', '/Users/boss'],
    ['~name is not expanded', '~other/data.csv', '/work/dir/~other/data.csv'],
    ['relative path', 'data.csv', '/work/dir/data.csv'],
    ['dot-relative path', './sub/../data.csv', '/work/dir/data.csv'],
    ['bracketed paste markers', '\u001b[200~/Users/boss/data.csv\u001b[201~', '/Users/boss/data.csv'],
    ['broken file URL is kept for the existence check', 'file://%zz', '/work/dir/file:/%zz'],
    ['empty', '', undefined],
    ['blanks only', '   \t ', undefined],
  ];
  it.each(cases)('%s', (_name, input, expected) => {
    expect(normalizeDroppedPath(input, home, cwd)).toBe(expected);
  });
});

describe('isInteractive', () => {
  it('needs a terminal on both ends', () => {
    expect(isInteractive(scriptedTerminal([], true).io)).toBe(true);
    expect(isInteractive(scriptedTerminal([], false).io)).toBe(false);
    const half = scriptedTerminal([], true);
    Object.assign(half.io.output, { isTTY: false });
    expect(isInteractive(half.io)).toBe(false);
  });
});

describe('menu navigation', () => {
  it('shows the menu, the guide and quits with 0', async () => {
    const f = fixture(['6', '', '0']);
    expect(await runMenu(f.host)).toBe(0);
    const screen = f.screen();
    for (const entry of ['1. Check a CSV file', '2. Log in an app account', '3. View logged-in accounts', '4. Rebuild the latest report', '5. Check this Mac is ready', '6. Guide / warnings', 'L. Language / Ngôn ngữ / Bahasa / 언어 / 语言: English', '0. Quit', 'v9.9.9']) {
      expect(screen).toContain(entry);
    }
    for (const warning of ['agreed to be contacted', 'not_found', '(privacy)', 'HK / JP / KR / TW / TH', 'Zalo only checks Vietnamese numbers (+84)', 'restricted or banned']) {
      expect(f.flat()).toContain(warning);
    }
    expect(screen).toContain('Goodbye.');
    expect(f.runs).toEqual([]);
    expect(f.remaining()).toEqual([]);
  });

  it('shows the menu again after each action', async () => {
    const f = fixture(['6', '', '6', '', '0']);
    await runMenu(f.host);
    expect(f.screen().split('=== Phone App Checker').length - 1).toBe(3);
  });

  it('rejects invalid input, ignores an empty line and stays in the menu', async () => {
    const f = fixture(['9', 'abc', '', '  ', '0']);
    expect(await runMenu(f.host)).toBe(0);
    const screen = f.screen();
    expect(screen).toContain('Invalid choice: "9"');
    expect(screen).toContain('Invalid choice: "abc"');
    expect(screen.match(/Invalid choice/g)).toHaveLength(2);
    expect(screen).toContain('Goodbye.');
  });

  it('shows hostile menu input without escape or bidi characters', async () => {
    const f = fixture(['\u001b[2J\u202Eevil\u0007\r', '0']);
    await runMenu(f.host);
    const screen = f.screen();
    expect(screen).toContain('evil');
    expect(screen).not.toMatch(/[\u001b\u202E\u0007\r]/);
  });

  it('says goodbye at end of input, at the menu and in the middle of a question: one farewell, however the menu ends', async () => {
    const atMenu = fixture([]);
    expect(await runMenu(atMenu.host)).toBe(0);
    expect(atMenu.screen()).toContain('Goodbye.');

    const midQuestion = fixture(['1'], { accounts: { telegram: ['a'] } });
    expect(await runMenu(midQuestion.host)).toBe(0);
    expect(midQuestion.screen()).toContain('CSV file');
    expect(midQuestion.screen().match(/Goodbye\./g)).toHaveLength(1);
    expect(midQuestion.screen()).not.toContain('Exited');
    expect(midQuestion.runs).toEqual([]);
  });
});

describe('simple actions', () => {
  it('3 runs `accounts` when accounts exist', async () => {
    const f = fixture(['3', '', '0'], { accounts: { telegram: ['a'] } });
    await runMenu(f.host);
    expect(f.runs).toEqual([['accounts']]);
  });

  it('3 shows the no-accounts hint without running `accounts` when nobody is logged in', async () => {
    const f = fixture(['3', '0']);
    await runMenu(f.host);
    expect(f.flat()).toContain('No account is logged in yet');
    expect(f.runs).toEqual([]);
  });

  it('5 runs `doctor` once and adds only the menu\'s own hint (the offline-readiness note is part of the doctor output)', async () => {
    const f = fixture(['5', '', '0']);
    await runMenu(f.host);
    expect(f.runs).toEqual([['doctor']]);
    // The note is printed by `doctor` itself; the menu must not say it a second time.
    expect(f.screen()).not.toContain('does NOT verify real accounts');
    expect(DOCTOR_FOOTER).toContain('offline readiness only');
  });

  it('a failing command shows its message and the menu keeps going', async () => {
    const f = fixture(['3', '', '5', '', '6', '', '0'], {
      results: [
        { code: 1, error: 'database is locked' },
        { code: 1 },
      ],
      accounts: { telegram: ['a'] },
    });
    expect(await runMenu(f.host)).toBe(0);
    const screen = f.flat();
    expect(screen).toContain('Error: database is locked');
    expect(screen).toContain('The command did not succeed (code 1)');
    expect(screen).toContain('A line says FAIL');
    expect(screen).toContain('GUIDE AND WARNINGS');
    expect(screen).toContain('Goodbye.');
    expect(f.runs).toEqual([['accounts'], ['doctor']]);
  });

  it('shows a broken config as a message instead of leaving the menu', async () => {
    const f = fixture(['1', '2', '4', '0'], {
      loadConfig: () => {
        throw new Error('bad\u001b[31m json');
      },
    });
    expect(await runMenu(f.host)).toBe(0);
    expect(f.flat().match(/Cannot read the configuration: bad +json/g)).toHaveLength(3);
    expect(f.screen()).not.toContain('\u001b');
    expect(f.runs).toEqual([]);
  });
});

describe('1 - check a CSV', () => {
  it('checks every logged-in app by default and reports where the report is', async () => {
    const f = fixture(['1', CSV_PATH(), '', '', '', '0'], { accounts: { telegram: ['a'], zalo: ['z'] } });
    await runMenu(f.host);
    expect(f.runs).toEqual([['check', '--out', join(work, 'report.csv'), '--apps', 'telegram,zalo', '--', CSV_PATH()]]);
    expect(f.flat().replaceAll(' ', '')).toContain(`Done. Report: ${join(work, 'report.csv')}`.replaceAll(' ', ''));
    expect(f.screen()).toContain('Goodbye.');
  });

  it('lets the user pick apps by number or name and re-asks on nonsense', async () => {
    const f = fixture(['1', CSV_PATH(), '', 'x9', '3', '', '0'], { accounts: { telegram: ['a'], whatsapp: ['w'], zalo: ['z'] } });
    await runMenu(f.host);
    expect(f.flat()).toContain('Did not understand "x9"');
    // "3" is Zalo here (telegram, whatsapp, zalo are the three logged-in apps).
    expect(f.flat()).toContain('Logged-in apps:');
    expect(f.runs[0]?.[4]).toBe('zalo');

    const byName = fixture(['1', CSV_PATH(), '', 'whatsapp, telegram', '', '0'], { accounts: { telegram: ['a'], whatsapp: ['w'] } });
    await runMenu(byName.host);
    expect(byName.runs[0]?.[4]).toBe('telegram,whatsapp');
  });

  it('shows what the user typed when it names no app, in the case it was typed (not folded to lower case)', async () => {
    const f = fixture(['1', CSV_PATH(), '', 'WhatsApp, Signal-X', '', '0'], { accounts: { telegram: ['a'], whatsapp: ['w'] } });
    await runMenu(f.host);
    expect(f.flat()).toContain('Did not understand "Signal-X"');
  });

  it('re-asks for an empty file at once instead of failing after the other questions', async () => {
    const empty = join(work, 'empty.csv');
    writeFileSync(empty, '');
    const f = fixture(['1', empty, '', '0'], { accounts: { telegram: ['a'] } });
    await runMenu(f.host);
    expect(f.flat()).toContain(`This file is empty: ${empty}`);
    expect(f.runs).toEqual([]);
  });

  it('does not ask which app when only one is logged in', async () => {
    const f = fixture(['1', CSV_PATH(), '', '', '0'], { accounts: { line: ['l'] } });
    await runMenu(f.host);
    expect(f.screen()).not.toContain('Check which apps?');
    expect(f.runs[0]?.[4]).toBe('line');
  });

  it('accepts a dragged path: quoted, escaped spaces, file:// and ~', async () => {
    const spaced = join(work, 'My Customers (1).csv');
    writeFileSync(spaced, CSV);
    const escaped = spaced.replace(/[ ()]/g, (c) => `\\${c}`);
    const fileUrl = `file://${encodeURI(spaced)}`;
    for (const typed of [`${escaped} `, `'${spaced}' `, `"${spaced}"`, fileUrl]) {
      const f = fixture(['1', typed, '', '', '0'], { accounts: { telegram: ['a'] } });
      await runMenu(f.host);
      expect(f.runs[0]?.at(-1)).toBe(spaced);
    }

    const f = fixture(['1', '~/in-home.csv', '', '', '0'], { accounts: { telegram: ['a'] } });
    const home = join(dir, 'fakehome');
    mkdirSync(home);
    writeFileSync(join(home, 'in-home.csv'), CSV);
    await runMenu({ ...f.host, homeDir: home });
    expect(f.runs[0]?.at(-1)).toBe(join(home, 'in-home.csv'));

    const relative = fixture(['1', 'customers.csv', '', '', '0'], { accounts: { telegram: ['a'] } });
    await runMenu(relative.host);
    expect(relative.runs[0]?.at(-1)).toBe(CSV_PATH());
  });

  it('re-asks for a missing file, a folder and an unreadable file, and b goes back', async () => {
    const locked = join(work, 'locked.csv');
    writeFileSync(locked, CSV);
    chmodSync(locked, 0o000);
    const readable = process.getuid?.() === 0 || (() => { try { readFileSync(locked); return true; } catch { return false; } })();
    const f = fixture(['1', join(work, 'nope.csv'), work, ...(readable ? [] : [locked]), 'b', '0'], { accounts: { telegram: ['a'] } });
    await runMenu(f.host);
    chmodSync(locked, 0o600);
    const screen = f.flat();
    expect(screen.replaceAll(' ', '')).toContain(`File not found: ${join(work, 'nope.csv')}`.replaceAll(' ', ''));
    expect(screen.replaceAll(' ', '')).toContain(`This is not a file: ${work}`.replaceAll(' ', ''));
    if (!readable) expect(screen.replaceAll(' ', '')).toContain('Cannot read the file (no permission):'.replaceAll(' ', ''));
    expect(f.runs).toEqual([]);
    expect(screen).toContain('Goodbye.');
  });

  it('shows a hostile path without escape, bidi or line-break characters', async () => {
    const hostile = join(work, '\u001b[31m\u202Egnp.csv\u001b]0;pwned\u0007\u2028forged.csv');
    const f = fixture(['1', hostile, '', '', '0'], { accounts: { telegram: ['a'] } });
    await runMenu(f.host);
    const screen = f.screen();
    expect(screen).toContain('File not found:');
    expect(screen).toContain('gnp.csv');
    expect(screen).not.toMatch(/[\u001b\u202E\u2028\u0007]/);
    expect(f.runs).toEqual([]);
  });

  it('asks before overwriting an existing report, and only overwrites on yes', async () => {
    writeFileSync(join(work, 'report.csv'), 'old');
    const declined = fixture(['1', CSV_PATH(), '', '', 'x', 'n', '0'], { accounts: { telegram: ['a'] } });
    await runMenu(declined.host);
    expect(declined.flat()).toContain(`File ${join(work, 'report.csv')} already exists. Overwrite`);
    expect(declined.screen()).toContain('Please type y (yes) or n (no).');
    expect(declined.flat()).toContain('Cancelled, no file was overwritten.');
    expect(declined.runs).toEqual([]);

    const byDefault = fixture(['1', CSV_PATH(), '', '', '', '0'], { accounts: { telegram: ['a'] } });
    await runMenu(byDefault.host);
    expect(byDefault.runs).toEqual([]);

    for (const yes of ['y', 'Y', 'yes', ' YES ']) {
      const accepted = fixture(['1', CSV_PATH(), '', '', yes, '0'], { accounts: { telegram: ['a'] } });
      await runMenu(accepted.host);
      expect(accepted.runs).toHaveLength(1);
    }
  });

  it('uses a custom report file and a folder as the report location', async () => {
    const custom = fixture(['1', CSV_PATH(), '', join(work, 'out file.csv'), '0'], { accounts: { telegram: ['a'] } });
    await runMenu(custom.host);
    expect(custom.runs[0]?.[2]).toBe(join(work, 'out file.csv'));

    const folder = join(dir, 'reports');
    mkdirSync(folder);
    const intoFolder = fixture(['1', CSV_PATH(), '', folder, '0'], { accounts: { telegram: ['a'] } });
    await runMenu(intoFolder.host);
    expect(intoFolder.runs[0]?.[2]).toBe(join(folder, 'report.csv'));
  });

  it('puts the default report in the current folder when the CSV folder is not writable', async () => {
    const readOnly = join(dir, 'readonly');
    mkdirSync(readOnly);
    writeFileSync(join(readOnly, 'in.csv'), CSV);
    chmodSync(readOnly, 0o500);
    try {
      const writable = (() => { try { writeFileSync(join(readOnly, 'probe'), ''); return true; } catch { return false; } })();
      const f = fixture(['1', join(readOnly, 'in.csv'), '', '', '0'], { accounts: { telegram: ['a'] } });
      await runMenu(f.host);
      expect(f.runs[0]?.[2]).toBe(join(writable ? readOnly : work, 'report.csv'));
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });

  it('says so when nobody is logged in and offers to log in', async () => {
    const f = fixture(['1', 'y', '', '0']);
    await runMenu(f.host);
    expect(f.flat()).toContain('No account is logged in yet');
    expect(f.flat()).toContain('Log in to which app?');
    expect(f.runs).toEqual([]);

    const declined = fixture(['1', 'n', '0']);
    await runMenu(declined.host);
    expect(declined.flat()).not.toContain('Log in to which app?');
  });

  it('a failed check shows its message and stays in the menu; an interrupted one says it can resume', async () => {
    const failed = fixture(['1', CSV_PATH(), '', '', '0'], {
      accounts: { telegram: ['a'] },
      results: [{ code: 1, error: 'no valid phone numbers (2 invalid)' }],
    });
    expect(await runMenu(failed.host)).toBe(0);
    expect(failed.flat()).toContain('Error: no valid phone numbers (2 invalid)');
    expect(failed.flat()).not.toContain('Done. Report');
    expect(failed.screen()).toContain('Goodbye.');

    const stopped = fixture(['1', CSV_PATH(), '', '', '0'], { accounts: { telegram: ['a'] }, results: [{ code: 130 }] });
    await runMenu(stopped.host);
    expect(stopped.flat()).toContain('Stopped midway');
  });
});

/** Arguments every login run ends with: the language the menu is in, so the login screens match it. */
const EN = ['--lang', 'en'];
const SECRET = 'deadbeefcafe0123deadbeefcafe0123';

describe('2 - login', () => {
  it('lists the five apps with their status and runs login with the default account', async () => {
    // 2 = login, 2 = WhatsApp, Enter = default account, 2 = QR (1 / Enter = pairing code).
    const f = fixture(['2', '2', '', '2', '0'], { accounts: { telegram: ['a', 'b'] } });
    await runMenu(f.host);
    const screen = f.screen();
    expect(screen).toMatch(/1\. telegram: logged in: 2 accounts \(a, b\)/);
    for (const app of ['whatsapp', 'zalo', 'viber', 'line']) expect(screen).toMatch(new RegExp(`${app}: not set up`));
    expect(f.runs).toEqual([['login', 'whatsapp', '--account', 'default', '--method', 'qr', ...EN]]);
    expect(screen).toContain('Next step: choose 1 ("Check a CSV file")');
    expect(screen).toContain('QR');
  });

  it('lists a single account in the singular', async () => {
    const f = fixture(['2', '', '0'], { accounts: { whatsapp: ['default'] } });
    await runMenu(f.host);
    expect(f.screen()).toMatch(/2\. whatsapp: logged in: 1 account \(default\)/);
  });

  it('accepts an app name, validates the account name and re-asks', async () => {
    const f = fixture(['2', 'Zalo', '../etc', 'a b', 'shop-1', '0']);
    await runMenu(f.host);
    expect(f.screen().match(/Use only letters without accents/g)).toHaveLength(2);
    expect(f.runs).toEqual([['login', 'zalo', '--account', 'shop-1', ...EN]]);
  });

  it('re-asks for an unknown app and Enter goes back without running anything', async () => {
    const f = fixture(['2', '9', 'signal', 'b', '0']);
    await runMenu(f.host);
    expect(f.screen()).toContain('Did not understand "9"');
    expect(f.screen()).toContain('Did not understand "signal"');
    expect(f.runs).toEqual([]);
  });

  it('asks before re-logging in an existing account', async () => {
    const declined = fixture(['2', '3', 'z', 'n', '0'], { accounts: { zalo: ['z'] } });
    await runMenu(declined.host);
    expect(declined.flat()).toContain('Logging in again replaces the old login session');
    expect(declined.runs).toEqual([]);

    const accepted = fixture(['2', '3', 'z', 'y', '0'], { accounts: { zalo: ['z'] } });
    await runMenu(accepted.host);
    expect(accepted.runs).toEqual([['login', 'zalo', '--account', 'z', ...EN]]);
  });

  it('a failing login shows the reason, says nothing was saved and returns to the menu', async () => {
    const f = fixture(['2', '4', '', '0'], { results: [{ code: 1, error: 'OTP rejected' }] });
    expect(await runMenu(f.host)).toBe(0);
    const screen = f.screen();
    expect(screen).toContain('Error: OTP rejected');
    expect(screen).toContain('Login of viber (account default) did not finish and nothing was saved');
    expect(screen).not.toContain('Next step');
    expect(screen).toContain('Goodbye.');
  });

  describe('WhatsApp', () => {
    it('offers the pairing code first (recommended, the default) and the QR second, and re-asks on anything else', async () => {
      const f = fixture(['2', '2', '', 'x', '3', '2', '0']);
      await runMenu(f.host);
      const screen = f.screen();
      expect(screen).toContain('How do you want to link WhatsApp?');
      expect(f.flat()).toContain('1. Link with your phone number: type an 8-character code on your phone (recommended)');
      expect(f.flat()).toContain('2. Scan a QR code with your phone');
      expect(screen.match(/Please type a number from 1 to 2\./g)).toHaveLength(2);
      expect(f.runs).toEqual([['login', 'whatsapp', '--account', 'default', '--method', 'qr', ...EN]]);
    });

    it('Enter at the method question means the pairing code, which asks for the phone number', async () => {
      const f = fixture(['2', '2', '', '', '0901234567', '0']);
      await runMenu(f.host);
      expect(f.flat()).toContain('Phone number of the WhatsApp account you are linking');
      expect(f.runs).toEqual([['login', 'whatsapp', '--account', 'default', '--method', 'code', '--phone', '+84901234567', ...EN]]);
    });

    it('asks for the phone number, validates it with the phone normaliser and passes it to the pairing-code login', async () => {
      const f = fixture(['2', '2', '', '1', 'abc', '12', '0901234567', '0']);
      await runMenu(f.host);
      const screen = f.screen();
      expect(screen.match(/does not look like a valid phone number/g)).toHaveLength(2);
      // The steps on the phone come with the code itself (printed by the login); the menu does not say them twice.
      expect(screen).not.toContain('Link with phone number instead');
      expect(f.runs).toEqual([['login', 'whatsapp', '--account', 'default', '--method', 'code', '--phone', '+84901234567', ...EN]]);
    });

    it('after a successful login it names the next step once, and does not repeat the command\'s own success line', async () => {
      const f = fixture(['2', '2', '', '1', '0901234567', '0']);
      await runMenu(f.host);
      const screen = f.screen();
      expect(screen.match(/Next step: choose 1 \("Check a CSV file"\)/g)).toHaveLength(1);
      expect(screen).not.toContain('Logged in');
    });

    it('b at the phone question goes back without running anything', async () => {
      const f = fixture(['2', '2', '', '1', 'b', '0']);
      await runMenu(f.host);
      expect(f.runs).toEqual([]);
      expect(f.screen()).toContain('Goodbye.');
    });
  });

  describe('Telegram', () => {
    const saved = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as { apps: { telegram: { options: Record<string, unknown> } } };

    it('asks for the api_id and the hidden api_hash when missing, saves them privately and logs in with QR', async () => {
      const f = fixture(['2', '1', 'tg1', '12ab', '1234567', 'nothex', SECRET.toUpperCase(), '', '0']);
      await runMenu(f.host);
      const screen = f.screen();
      expect(screen).toContain('https://my.telegram.org/apps');
      expect(f.flat()).toContain('The api_id is a number made of digits only');
      expect(f.flat()).toContain('The api_hash is exactly 32 characters');
      expect(f.flat()).toContain(`api_id and api_hash saved in ${join(dir, 'config.json')}`);
      expect(f.flat()).toContain('Telegram will show a QR code');
      // Saved in the existing config (other settings kept), owner-only, and never printed back.
      const file = join(dir, 'config.json');
      expect(saved(file).apps.telegram.options).toEqual({ apiId: 1234567, apiHash: SECRET });
      expect(JSON.parse(readFileSync(file, 'utf8')).dataDir).toBe(join(dir, 'data'));
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(screen).not.toContain(SECRET);
      expect(screen).not.toContain(SECRET.toUpperCase());
      expect(f.runs).toEqual([['login', 'telegram', '--account', 'tg1', '--method', 'qr', ...EN]]);
      expect(screen).toContain('Next step: choose 1');
    });

    it('b at the api_id or the api_hash question goes back and saves nothing', async () => {
      const atId = fixture(['2', '1', '', 'b', '0']);
      await runMenu(atId.host);
      expect(atId.runs).toEqual([]);
      expect(saved(join(dir, 'config.json')).apps.telegram.options).toEqual({});

      const atHash = fixture(['2', '1', '', '1234567', 'b', '0']);
      await runMenu(atHash.host);
      expect(atHash.runs).toEqual([]);
      expect(saved(join(dir, 'config.json')).apps.telegram.options).toEqual({});
    });

    it('shows why the credentials could not be saved (without the secret) and does not log in', async () => {
      const f = fixture(['2', '1', '', '1234567', SECRET, '0'], {
        host: {
          saveTelegramCredentials: () => {
            throw new Error('the config file is not valid JSON; fix it first');
          },
        },
      });
      await runMenu(f.host);
    expect(f.flat()).toContain('Could not save the api_id / api_hash: the config file is not valid JSON');
      expect(f.screen()).not.toContain(SECRET);
      expect(f.runs).toEqual([]);
    });

    it('goes straight to the method question when the credentials are already set, and never prints them', async () => {
      const f = fixture(['2', '1', '', '2', '0'], { telegram: { apiId: 1234567, apiHash: SECRET } });
      await runMenu(f.host);
      expect(f.runs).toEqual([['login', 'telegram', '--account', 'default', '--method', 'code', ...EN]]);
      expect(f.screen()).not.toContain('my.telegram.org');
      expect(f.screen()).not.toContain(SECRET);
    expect(f.flat()).toContain('two-step password');
    });

    it('takes credentials from the environment too', async () => {
      const f = fixture(['2', '1', '', '', '0'], { host: { env: { TELEGRAM_API_ID: '1234567', TELEGRAM_API_HASH: SECRET } } });
      await runMenu(f.host);
      expect(f.screen()).not.toContain('my.telegram.org');
      expect(f.runs).toEqual([['login', 'telegram', '--account', 'default', '--method', 'qr', ...EN]]);
    });
  });
});

describe('4 - view the latest report', () => {
  it('rebuilds the report for the CSV used last, with the logged-in apps', async () => {
    const f = fixture(['1', CSV_PATH(), '', '', '', '4', '', '', '', '0'], { accounts: { telegram: ['a'], zalo: ['z'] } });
    await runMenu(f.host);
    expect(f.runs).toEqual([
      ['check', '--out', join(work, 'report.csv'), '--apps', 'telegram,zalo', '--', CSV_PATH()],
      ['report', '--out', join(work, 'report.csv'), '--apps', 'telegram,zalo', '--', CSV_PATH()],
    ]);
  });

  it('asks for the CSV when none was used yet, and falls back to the config apps when nobody is logged in', async () => {
    const f = fixture(['4', CSV_PATH(), '', '', '0']);
    await runMenu(f.host);
    expect(f.screen()).toContain('CSV file (b = back)');
    expect(f.runs).toEqual([['report', '--out', join(work, 'report.csv'), '--', CSV_PATH()]]);
  });

  it('b without a CSV goes back', async () => {
    const f = fixture(['4', 'b', '0']);
    await runMenu(f.host);
    expect(f.runs).toEqual([]);
  });
});

describe('menu through main()', () => {
  function fakeAdapter(app: App): Adapter {
    return {
      app,
      async login() {},
      async open() {
        return {
          async check(batch) {
            return new Map(batch.map((n) => [n.e164, n.country === 'VN' ? ('yes' as const) : ('not_found' as const)]));
          },
          async close() {},
        };
      },
    };
  }

  function deps(terminal: ScriptedTerminal, printed: string[], logged: string[]) {
    const appHome = join(dir, 'app-home');
    return {
      terminal: terminal.io,
      env: { HOME: join(dir, 'home'), PHONE_APP_CHECKER_HOME: appHome },
      lifecycleDir: join(dir, 'lifecycle'),
      loadAdapter: async (app: App) => fakeAdapter(app),
      now: () => Date.UTC(2026, 9, 8, 5, 0, 0),
      sleep: async () => {},
      random: () => 0,
      log: (message: string) => logged.push(message),
      print: (text: string) => printed.push(text),
      exit: () => {},
      appHome,
    };
  }

  it('opens on a terminal with no arguments and runs real commands: accounts, then a failing check, then quit', async () => {
    const terminal = scriptedTerminal(['3', '', '1', 'n', '0'], true);
    const printed: string[] = [];
    const logged: string[] = [];
    const d = deps(terminal, printed, logged);
    expect(await main(['node', 'phone-app-checker'], d)).toBe(0);
    expect(terminal.screen()).toContain('=== Phone App Checker');
    expect(printed).toEqual([]);
    expect(terminal.screen().replace(/\s+/g, ' ')).toContain('No account is logged in yet');
    // The menu opens quietly: the first-run notice (which points at the doctor command) is for the command line.
    expect(logged.some((line) => line.startsWith('First run'))).toBe(false);
    expect(existsSync(join(d.appHome, 'checker.config.json'))).toBe(true);
    expect(terminal.screen()).toContain('Goodbye.');
    expect(process.exitCode).toBeUndefined();
  });

  it('runs a full check from the menu, then shows a failure without leaving', async () => {
    const appHome = join(dir, 'app-home');
    mkdirSync(join(appHome, 'data', 'sessions', 'telegram', 'a'), { recursive: true });
    const bad = join(work, 'bad.csv');
    writeFileSync(bad, 'name,phone\nAn,abc\n');
    const terminal = scriptedTerminal(['1', CSV_PATH(), '', '', '1', bad, '', '', 'n', '0'], true);
    const printed: string[] = [];
    const logged: string[] = [];
    const d = deps(terminal, printed, logged);
    expect(await main(['node', 'phone-app-checker'], d)).toBe(0);
    const report = readFileSync(join(work, 'report.csv'), 'utf8');
    expect(report).toContain('0901234567,+84901234567,VN,yes');
    expect(report).toContain('+65 9123 4567,+6591234567,SG,not_found');
    // The path may wrap mid-token at the window edge: compare without blanks.
    expect(terminal.screen().replaceAll(/\s+/g, '')).toContain(`Done. Report: ${join(work, 'report.csv')}`.replaceAll(/\s+/g, ''));
    expect(printed.join('\n')).toContain('telegram');
    // The second run overwrote nothing: the existing report asked for confirmation first (answered '' = no).
    expect(terminal.screen().replace(/\s+/g, ' ')).toContain('Overwrite');
    expect(terminal.screen()).toContain('Goodbye.');
    expect(process.exitCode).toBeUndefined();
  });

  it('a command failure inside the menu is shown and the menu continues', async () => {
    const appHome = join(dir, 'app-home');
    mkdirSync(join(appHome, 'data', 'sessions', 'telegram', 'a'), { recursive: true });
    const bad = join(work, 'bad.csv');
    writeFileSync(bad, 'name,phone\nAn,abc\n');
    const terminal = scriptedTerminal(['1', bad, '', '', '0'], true);
    const d = deps(terminal, [], []);
    expect(await main(['node', 'phone-app-checker'], d)).toBe(0);
    expect(terminal.screen().replace(/\s+/g, ' ')).toContain('Error: no valid phone numbers');
    expect(terminal.screen()).toContain('Goodbye.');
  });

  it('does not open the menu when a command is given, even on a terminal', async () => {
    const terminal = scriptedTerminal([], true);
    const printed: string[] = [];
    const d = deps(terminal, printed, []);
    expect(await main(['node', 'phone-app-checker', 'accounts'], d)).toBe(0);
    expect(printed).toEqual(['No accounts yet. Log in first (menu item 2, or run: phone-app-checker login <app> --account <name>).']);
    expect(terminal.screen()).not.toContain('Phone App Checker');
  });

  it('ends with code 0 on Ctrl+D at the menu', async () => {
    const terminal = scriptedTerminal([], true);
    expect(await main(['node', 'phone-app-checker'], deps(terminal, [], []))).toBe(0);
  });
});

describe('real process without a terminal', () => {
  const entry = join(REPO, 'bin', 'phone-app-checker.js');
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: work,
      // stdin is closed and stdout is a pipe: no terminal, so the menu must not open (and must not wait).
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: join(dir, 'home'), PHONE_APP_CHECKER_HOME: '' },
    });

  it('with no arguments still prints the usage and exits 1, as before', () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: phone-app-checker [options] [command]');
    expect(result.stderr).toContain('Commands:');
    expect(result.stderr).not.toContain('Choose (0-6');
    expect(result.stdout).toBe('');
  });

  it('--lang without a terminal is not a command: usage error, nothing waits', () => {
    const result = run(['--lang', 'vi']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown option '--lang'");
    expect(result.stdout).toBe('');
  });

  it('--help mentions that no arguments opens the menu', () => {
    const result = run(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Run with no arguments in a terminal to open an interactive menu');
    expect(result.stdout).toContain('English by default');
    expect(result.stdout).toContain('PHONE_APP_CHECKER_LANG=<en|vi|id|ms|ko|zh>');
  });

  it('subcommand help is unchanged', () => {
    const result = run(['check', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('interactive menu');
  });

  it('piped (non-terminal) stdin with no arguments does not hang either', () => {
    const result = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
      encoding: 'utf8',
      timeout: 30_000,
      cwd: work,
      input: '0\n',
      env: { ...process.env, HOME: join(dir, 'home'), PHONE_APP_CHECKER_HOME: '' },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage:');
  });
});

describe('language', () => {
  const saved = (): { calls: Lang[]; save: (lang: Lang) => void } => {
    const calls: Lang[] = [];
    return { calls, save: (lang) => void calls.push(lang) };
  };

  it('is English by default: no flag, no variable, nothing saved, whatever the system locale says', async () => {
    const f = fixture(['0'], { host: { env: { LANG: 'vi_VN.UTF-8', LC_ALL: 'vi_VN.UTF-8' }, readLanguage: () => undefined } });
    await runMenu(f.host);
    const screen = f.screen();
    expect(screen).toContain('1. Check a CSV file');
    expect(screen).toContain('Choose 0-6 or L, then Enter:');
    expect(screen).toContain('L. Language / Ngôn ngữ / Bahasa / 언어 / 语言: English');
    expect(screen).toContain('Goodbye.');
    expect(screen).not.toMatch(/Kiểm tra|Thoát/);
  });

  it('L lists the six languages in their own script and switches at once; the choice is saved', async () => {
    const s = saved();
    const f = fixture(['l', '2', '0'], { host: { saveLanguage: s.save } });
    await runMenu(f.host);
    const screen = f.screen();
    for (const name of ['1. English *', '2. Tiếng Việt', '3. Bahasa Indonesia', '4. Bahasa Melayu', '5. 한국어', '6. 简体中文']) {
      expect(screen).toContain(name);
    }
    expect(screen).toContain('Ngôn ngữ: Tiếng Việt.');
    // After the switch the menu is Vietnamese, and the switch is still on offer.
    expect(screen).toContain('1. Kiểm tra file CSV');
    expect(screen).toContain('L. Language / Ngôn ngữ / Bahasa / 언어 / 语言: Tiếng Việt');
    expect(screen).toContain('Tạm biệt.');
    expect(s.calls).toEqual(['vi']);
    expect(f.remaining()).toEqual([]);
  });

  it('accepts a number, a code in any case or a language name, re-asks on nonsense and Enter goes back', async () => {
    const s = saved();
    const f = fixture(['L', '9', 'klingon', 'KO', 'L', 'bahasa melayu', 'L', '', 'L', '6', '0'], { host: { saveLanguage: s.save } });
    await runMenu(f.host);
    expect(f.screen()).toContain('Did not understand "9"');
    expect(f.screen()).toContain('Did not understand "klingon"');
    expect(s.calls).toEqual(['ko', 'ms', 'zh']);
    expect(f.screen()).toContain('再见。');
  });

  it('flag beats the environment, the environment beats the saved choice, the saved choice beats the default', async () => {
    const cases: [string, MenuHost['env'], string | undefined, string | undefined, string][] = [
      ['saved only', {}, undefined, 'ko', '종료'],
      ['env beats saved', { PHONE_APP_CHECKER_LANG: 'zh' }, undefined, 'ko', '退出'],
      ['flag beats env and saved', { PHONE_APP_CHECKER_LANG: 'zh' }, 'id', 'ko', 'Keluar'],
      ['env in other case with blanks', { PHONE_APP_CHECKER_LANG: ' MS ' }, undefined, undefined, 'Keluar'],
      ['empty env counts as unset', { PHONE_APP_CHECKER_LANG: '' }, undefined, 'vi', 'Thoát'],
      ['empty flag counts as unset', {}, '  ', 'vi', 'Thoát'],
    ];
    for (const [name, env, flag, stored, quit] of cases) {
      const f = fixture(['0'], { host: { env, langFlag: flag, readLanguage: () => stored } });
      await runMenu(f.host);
      expect(f.screen(), name).toContain(`0. ${quit}`);
    }
  });

  it('unknown languages fall back to English, silently', async () => {
    const cases: [MenuHost['env'], string | undefined, string | undefined][] = [
      [{ PHONE_APP_CHECKER_LANG: 'klingon' }, undefined, 'vi'],
      [{}, 'xx', 'vi'],
      [{}, undefined, 'xx'],
      [{}, undefined, 'vi-VN'],
      [{}, undefined, ''],
    ];
    for (const [env, flag, stored] of cases) {
      const f = fixture(['0'], { host: { env, langFlag: flag, readLanguage: () => stored } });
      expect(await runMenu(f.host)).toBe(0);
      expect(f.screen()).toContain('0. Quit');
      expect(f.screen()).not.toMatch(/klingon|unsupported|unknown language/i);
    }
  });

  it('keeps the switch for the session and says so when it cannot be saved; the menu goes on', async () => {
    const failing = fixture(['L', '2', '6', '', '0'], {
      host: {
        saveLanguage: () => {
          throw new Error('EACCES: permission denied, open /secret/path');
        },
      },
    });
    expect(await runMenu(failing.host)).toBe(0);
    expect(failing.screen()).toContain('Không lưu được lựa chọn ngôn ngữ');
    expect(failing.screen()).toContain('HƯỚNG DẪN VÀ CẢNH BÁO');
    expect(failing.screen()).not.toContain('/secret/path');

    const nowhere = fixture(['L', '3', '0']);
    expect(await runMenu(nowhere.host)).toBe(0);
    expect(nowhere.screen()).toContain('Pilihan bahasa tidak dapat disimpan');
    expect(nowhere.screen()).toContain('Sampai jumpa.');
  });

  it('shows hostile input without control characters in every language', async () => {
    for (const lang of LANGS) {
      const f = fixture(['\u001b[2J\u202Eevil\u0007\r', 'L', '\u001b]0;x\u0007bad\u2028', '', '0'], { host: { langFlag: lang } });
      await runMenu(f.host);
      expect(f.screen(), lang).toContain('evil');
      expect(f.screen(), lang).toContain('bad');
      expect(f.screen(), lang).not.toMatch(/[\u001b\u202E\u2028\u0007\r]/);
    }
  });

  describe.each(LANGS)('%s', (lang) => {
    const msg = <K extends MessageKey>(key: K, ...args: MessageArgs<K>) => translate(lang, key, ...args);

    it('renders the main menu and every screen without throwing', async () => {
      const secret = 'deadbeefcafe0123deadbeefcafe0123';
      const f = fixture(
        ['', 'x', '6', '', '3', '', '5', '', '1', 'nope.csv', 'b', 'L', 'zz', '', '2', '9', '1', 'a b', 'tg1', 'b', '4', 'b', '0'],
        { accounts: { telegram: ['a'], zalo: ['z'] }, results: [{ code: 1, error: 'boom' }, { code: 1 }], host: { langFlag: lang } },
      );
      expect(await runMenu(f.host)).toBe(0);
      const screen = f.flat();
      expect(screen).toContain(`=== Phone App Checker v9.9.9 ===`);
      for (const [number, key] of [[1, 'menuCheck'], [2, 'menuLogin'], [3, 'menuAccounts'], [4, 'menuReport'], [5, 'menuDoctor'], [6, 'menuGuide'], [0, 'menuQuit']] as const) {
        expect(screen).toContain(`${number}. ${msg(key)}`);
      }
      expect(screen).toContain(`L. ${LANGUAGE_LABEL}: ${LANGUAGE_NAMES[lang]}`);
      expect(screen).toContain(msg('menuPrompt'));
      expect(screen).toContain(msg('menuInvalid', { choice: 'x' }));
      for (const key of ['guideTitle', 'guideConsent', 'guideNotFound', 'guideLine', 'guideZalo', 'guideBan', 'guideEvidence', 'guideDetails'] as const) {
        expect(screen).toContain(msg(key));
      }
      expect(screen).toContain(msg('commandError', { error: 'boom' }));
      expect(screen).toContain(msg('commandFailed', { code: 1 }));
      expect(screen).toContain(msg('doctorFailHint'));
      expect(screen).toContain(msg('goodbye'));
      expect(screen).not.toContain(secret);
      expect(f.remaining()).toEqual([]);
    });

    it('prints the login list without padding, so wide characters cannot misalign it', async () => {
      const f = fixture(['2', '', '0'], { accounts: { telegram: ['a', 'b'] }, host: { langFlag: lang } });
      await runMenu(f.host);
      const lines = f.screen().split('\n').filter((line) => {
        const match = /^ {2}\d\. ([a-z]+):/.exec(line);
        return match !== null && match[1] !== undefined && (APPS as readonly string[]).includes(match[1]);
      });
      expect(lines).toHaveLength(APPS.length);
      for (const line of lines) expect(line.slice(2)).not.toMatch(/ {2}/);
      expect(lines[0]).toBe(`  1. telegram: ${msg('appLoggedIn', { count: 2, names: 'a, b' })}`);
      expect(lines[1]).toBe(`  2. whatsapp: ${msg('appNotSetUp')}`);
    });

    it('guides Telegram credentials with the URL and field names intact, and asks for them', async () => {
      const f = fixture(['2', '1', '', '', '0'], { host: { langFlag: lang } });
      await runMenu(f.host);
      const screen = f.flat();
      for (const key of ['telegramIntro', 'telegramStep1', 'telegramStep2', 'telegramStep3', 'telegramSecretNote', 'telegramApiIdPrompt'] as const) {
        expect(screen).toContain(msg(key));
      }
      expect(screen).toContain('https://my.telegram.org/apps');
      expect(f.runs).toEqual([]);
    });

    it('asks how to link WhatsApp and Telegram, and says when a login did not finish', async () => {
      const wa = fixture(['2', '2', '', '1', '', '0'], { host: { langFlag: lang } });
      await runMenu(wa.host);
      for (const key of ['whatsappMethodIntro', 'whatsappMethodQr', 'whatsappMethodCode', 'whatsappPhonePrompt'] as const) {
        expect(wa.flat()).toContain(msg(key));
      }
      expect(wa.flat()).toContain(msg('loginMethodPrompt', { max: 2 }));

      const tg = fixture(['2', '1', '', '', '0'], { telegram: { apiId: 1234567, apiHash: SECRET }, results: [{ code: 1 }], host: { langFlag: lang } });
      await runMenu(tg.host);
      for (const key of ['telegramMethodIntro', 'telegramMethodQr', 'telegramMethodCode', 'hintTelegramQr'] as const) {
        expect(tg.flat()).toContain(msg(key));
      }
      expect(tg.flat()).toContain(msg('loginFailed', { app: 'telegram', account: 'default' }));
      expect(tg.runs).toEqual([['login', 'telegram', '--account', 'default', '--method', 'qr', '--lang', lang]]);
    });

    it('runs a check and confirms an overwrite with this language\'s words', async () => {
      writeFileSync(join(work, 'report.csv'), 'old');
      const yes = msg('answerYes').split(',')[1]?.trim() ?? 'y';
      const f = fixture(['1', CSV_PATH(), '', '', yes, '0'], { accounts: { telegram: ['a'] }, host: { langFlag: lang } });
      await runMenu(f.host);
      const folded = f.flat().replaceAll(' ', '');
      expect(folded).toContain(msg('reportExists', { path: join(work, 'report.csv') }).replaceAll(' ', ''));
      expect(folded).toContain(msg('reportDone', { path: join(work, 'report.csv') }).replaceAll(' ', ''));
      expect(f.runs).toHaveLength(1);

      const declined = fixture(['1', CSV_PATH(), '', '', 'maybe', msg('answerNo').split(',')[1]?.trim() ?? 'n', '0'], { accounts: { telegram: ['a'] }, host: { langFlag: lang } });
      await runMenu(declined.host);
      expect(declined.flat()).toContain(msg('confirmRetry'));
      expect(declined.flat()).toContain(msg('cancelledNoOverwrite'));
      expect(declined.runs).toEqual([]);
    });

    it('says goodbye at end of input too', async () => {
      const f = fixture([], { host: { langFlag: lang } });
      expect(await runMenu(f.host)).toBe(0);
      expect(f.screen()).toContain(msg('goodbye'));
    });
  });

  describe('parseYesNo', () => {
    const cases: [Lang, string, boolean | undefined][] = [
      ['en', 'y', true], ['en', ' YES ', true], ['en', 'n', false], ['en', 'No', false], ['en', 'c', undefined], ['en', '', undefined],
      ['vi', 'c', true], ['vi', 'có', true], ['vi', 'CÓ', true], ['vi', 'k', false], ['vi', 'không', false], ['vi', 'khong', false], ['vi', 'y', true], ['vi', 'n', false],
      ['id', 'ya', true], ['id', 'y', true], ['id', 't', false], ['id', 'tidak', false], ['id', 'maybe', undefined],
      ['ms', 'ya', true], ['ms', 't', false], ['ms', 'Tidak', false],
      ['ko', '예', true], ['ko', '네', true], ['ko', '아니요', false], ['ko', '아니오', false], ['ko', 'y', true], ['ko', 'n', false],
      ['zh', '是', true], ['zh', '否', false], ['zh', '不', false], ['zh', 'y', true], ['zh', 'n', false],
    ];
    it.each(cases)('%s %j', (lang, answer, expected) => {
      expect(parseYesNo(answer, lang)).toBe(expected);
    });
  });
});

describe('language through main()', () => {
  const entry = ['node', 'phone-app-checker'];
  const langFile = () => join(dir, 'app-home', 'menu-language');
  const appHome = () => join(dir, 'app-home');

  function deps(terminal: ScriptedTerminal, extraEnv: Record<string, string> = {}) {
    return {
      terminal: terminal.io,
      env: { HOME: join(dir, 'home'), PHONE_APP_CHECKER_HOME: appHome(), ...extraEnv },
      lifecycleDir: join(dir, 'lifecycle'),
      log: () => {},
      print: () => {},
      exit: () => {},
    };
  }

  async function start(answers: string[], args: string[] = [], extraEnv: Record<string, string> = {}): Promise<string> {
    const terminal = scriptedTerminal(answers, true);
    expect(await main([...entry, ...args], deps(terminal, extraEnv))).toBe(0);
    return terminal.screen();
  }

  function seed(content: string, mode = 0o600): void {
    mkdirSync(appHome(), { recursive: true, mode: 0o700 });
    writeFileSync(langFile(), content, { mode });
    chmodSync(langFile(), mode);
  }

  it('starts in English with no flag, variable or file, and saves no language just by opening', async () => {
    const screen = await start(['0']);
    expect(screen).toContain('1. Check a CSV file');
    expect(screen).toContain('Goodbye.');
    expect(existsSync(langFile())).toBe(false);
  });

  it('saves the switch as a private file and shows it on the next start', async () => {
    const first = await start(['L', '2', '0']);
    expect(first).toContain('Ngôn ngữ: Tiếng Việt.');
    expect(first).not.toContain('Could not save');
    expect(readFileSync(langFile(), 'utf8')).toBe('vi\n');
    expect(statSync(langFile()).mode & 0o777).toBe(0o600);
    expect(statSync(appHome()).mode & 0o777).toBe(0o700);
    // Only the language file was written: no stray temporary file, no config.
    expect(readdirSync(appHome()).sort()).toEqual(['checker.config.json', 'menu-language']);

    const second = await start(['0']);
    expect(second).toContain('1. Kiểm tra file CSV');
    expect(second).toContain('Tạm biệt.');

    const third = await start(['L', '1', '0']);
    expect(third).toContain('Language: English.');
    expect(readFileSync(langFile(), 'utf8')).toBe('en\n');
    expect(await start(['0'])).toContain('0. Quit');
  });

  it('replaces an existing language file atomically and keeps mode 600', async () => {
    seed('ko\n');
    await start(['L', '6', '0']);
    expect(readFileSync(langFile(), 'utf8')).toBe('zh\n');
    expect(statSync(langFile()).mode & 0o777).toBe(0o600);
    expect(readdirSync(appHome()).sort()).toEqual(['checker.config.json', 'menu-language']);
  });

  it('the environment variable beats the saved file, and --lang beats both', async () => {
    seed('vi\n');
    expect(await start(['0'], [], { PHONE_APP_CHECKER_LANG: 'ko' })).toContain('0. 종료');
    expect(await start(['0'], ['--lang', 'zh'], { PHONE_APP_CHECKER_LANG: 'ko' })).toContain('0. 退出');
    expect(await start(['0'], ['--lang=id'])).toContain('0. Keluar');
    expect(await start(['0'], ['--lang', 'ZH'])).toContain('0. 退出');
    // An unknown flag value is English, silently.
    expect(await start(['0'], ['--lang', 'elvish'])).toContain('0. Quit');
    expect(readFileSync(langFile(), 'utf8')).toBe('vi\n');
  });

  it('a switch made under an environment override is saved but the override still wins next time', async () => {
    await start(['L', '5', '0'], [], { PHONE_APP_CHECKER_LANG: 'zh' });
    expect(readFileSync(langFile(), 'utf8')).toBe('ko\n');
    expect(await start(['0'], [], { PHONE_APP_CHECKER_LANG: 'zh' })).toContain('0. 退出');
    expect(await start(['0'])).toContain('0. 종료');
  });

  it.each([
    ['garbage', 'bonjour\n', 0o600],
    ['unknown code', 'xx\n', 0o600],
    ['a region form', 'vi-VN\n', 0o600],
    ['two lines', 'vi\nko\n', 0o600],
    ['empty', '', 0o600],
    ['control characters', 'vi\u0000\u001b[2J', 0o600],
    ['oversized', `vi${' '.repeat(5000)}\n`, 0o600],
    ['group-readable', 'vi\n', 0o640],
    ['world-readable', 'vi\n', 0o644],
    ['group-writable', 'vi\n', 0o660],
    ['world-writable', 'vi\n', 0o666],
  ] as const)('ignores a language file that is %s', async (_name, content, mode) => {
    seed(content, mode);
    const screen = await start(['0']);
    expect(screen).toContain('0. Quit');
    expect(screen).not.toContain('Thoát');
  });

  it('accepts read-only (0400) and upper-case content', async () => {
    seed('VI\n', 0o400);
    expect(await start(['0'])).toContain('0. Thoát');
  });

  it('ignores a symlink, a directory, and a symlinked app home', async () => {
    mkdirSync(appHome(), { recursive: true, mode: 0o700 });
    const target = join(dir, 'elsewhere');
    writeFileSync(target, 'vi\n', { mode: 0o600 });
    symlinkSync(target, langFile());
    expect(await start(['0'])).toContain('0. Quit');
    rmSync(langFile());

    mkdirSync(langFile());
    expect(await start(['0'])).toContain('0. Quit');
    rmSync(langFile(), { recursive: true });

    const real = join(dir, 'real-home');
    mkdirSync(real, { mode: 0o700 });
    writeFileSync(join(real, 'menu-language'), 'vi\n', { mode: 0o600 });
    rmSync(appHome(), { recursive: true });
    symlinkSync(real, appHome());
    expect(await start(['0'])).toContain('0. Quit');
    // And a switch must not write through the symlink either: it is refused, non-fatally.
    const screen = await start(['L', '3', '0']);
    expect(screen).toContain('Pilihan bahasa tidak dapat disimpan');
    expect(readFileSync(join(real, 'menu-language'), 'utf8')).toBe('vi\n');
    expect(readdirSync(real)).toEqual(['menu-language']);
  });

  it('a failed save is not fatal: the switch lasts for the session and no temporary file is left', async () => {
    // A non-empty directory where the file should go: rename cannot replace it.
    mkdirSync(join(langFile(), 'inner'), { recursive: true });
    const screen = await start(['L', '3', '6', '', '0']);
    expect(screen).toContain('Bahasa: Bahasa Indonesia.');
    expect(screen).toContain('Pilihan bahasa tidak dapat disimpan');
    expect(screen).toContain('PANDUAN DAN PERINGATAN');
    expect(screen).toContain('Sampai jumpa.');
    expect(readdirSync(appHome()).sort()).toEqual(['checker.config.json', 'menu-language']);
    // Nothing valid saved, so the next start is English again.
    expect(await start(['0'])).toContain('0. Quit');
  });

  it('without an app home (source checkout) the switch works but is session-only', async () => {
    const terminal = scriptedTerminal(['L', '2', '0'], true);
    const d = { ...deps(terminal), env: { HOME: join(dir, 'home'), PHONE_APP_CHECKER_HOME: '' } };
    expect(await main(entry, d)).toBe(0);
    expect(terminal.screen()).toContain('Ngôn ngữ: Tiếng Việt.');
    expect(terminal.screen()).toContain('Không lưu được lựa chọn ngôn ngữ');
    expect(terminal.screen()).toContain('Tạm biệt.');
    expect(existsSync(join(dir, 'home'))).toBe(false);
  });

  it('never refuses the menu over the language: a home that cannot be validated just means English', async () => {
    // The app home is the user's own home directory: assertSafeAppRoot refuses it for saving.
    const terminal = scriptedTerminal(['L', '2', '0'], true);
    const d = { ...deps(terminal), env: { HOME: join(dir, 'home'), PHONE_APP_CHECKER_HOME: join(dir, 'home') } };
    mkdirSync(join(dir, 'home'));
    const previous = process.env.HOME;
    process.env.HOME = join(dir, 'home');
    try {
      expect(await main(entry, d)).toBe(0);
    } finally {
      process.env.HOME = previous;
    }
    expect(terminal.screen()).toContain('Không lưu được lựa chọn ngôn ngữ');
    expect(readdirSync(join(dir, 'home'))).toEqual([]);
  });
});
