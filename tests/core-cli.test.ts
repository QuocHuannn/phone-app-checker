import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram, main, type CliDeps } from '../src/cli.ts';
import { DOCTOR_FOOTER } from '../src/doctor.ts';
import { Store } from '../src/store.ts';
import { AccountBanned, type Adapter, type App, type CheckStatus } from '../src/types.ts';

const NOW = Date.UTC(2026, 9, 8, 5, 0, 0);
const ISO = '2026-10-08T05:00:00.000Z';

const CSV = ['name,phone', 'An,0901234567', 'Binh,+65 9123 4567', 'Chi,abc', 'Dung,090 123 4567', ''].join('\n');

interface Env {
  dir: string;
  csv: string;
  out: string;
  config: string;
  calls: string[];
  logs: string[];
  printed: string[];
  exits: number[];
  hupListeners: number;
}

let env: Env;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'checker-cli-'));
  const config = join(dir, 'config.json');
  writeFileSync(
    config,
    JSON.stringify({
      defaultRegion: 'VN',
      dataDir: join(dir, 'data'),
      apps: {
        telegram: { enabled: true, batchSize: 5, minIntervalMs: 0, jitterMs: 0 },
        whatsapp: { enabled: false },
        zalo: { enabled: true, batchSize: 5, minIntervalMs: 0, jitterMs: 0 },
      },
    }),
  );
  writeFileSync(join(dir, 'customers.csv'), CSV);
  mkdirSync(join(dir, 'data', 'sessions', 'telegram', 'a'), { recursive: true });
  mkdirSync(join(dir, 'data', 'sessions', 'zalo', 'z'), { recursive: true });
  env = {
    dir,
    csv: join(dir, 'customers.csv'),
    out: join(dir, 'report.csv'),
    config,
    calls: [],
    logs: [],
    printed: [],
    exits: [],
    hupListeners: process.listenerCount('SIGHUP'),
  };
});

afterEach(() => {
  rmSync(env.dir, { recursive: true, force: true });
});

function fakeAdapter(app: App, options: { banned?: boolean; loginFails?: boolean } = {}): Adapter {
  return {
    app,
    async login(ctx) {
      if (options.loginFails) throw new Error('OTP rejected');
      writeFileSync(join(ctx.accountDir, 'creds.json'), '{}');
    },
    async open() {
      return {
        async check(batch) {
          env.calls.push(`${app}:${batch.length}`);
          if (options.banned) throw new AccountBanned('logged out');
          return new Map<string, CheckStatus>(batch.map((n) => [n.e164, n.country === 'VN' ? 'yes' : 'not_found']));
        },
        async close() {},
      };
    },
  };
}

async function run(args: string[], adapters: Partial<Record<App, Adapter>> = {}): Promise<void> {
  const program = createProgram({
    loadAdapter: async (app) => adapters[app] ?? fakeAdapter(app),
    now: () => NOW,
    sleep: async () => {},
    random: () => 0,
    lifecycleDir: join(env.dir, 'lifecycle'),
    log: (message) => env.logs.push(message),
    print: (text) => env.printed.push(text),
    exit: (code) => {
      env.exits.push(code);
    },
  });
  await program.parseAsync(['--config', env.config, ...args], { from: 'user' });
}

const REPORT = [
  'input,e164,country,telegram,whatsapp,zalo,viber,line,last_checked_at,' +
    'telegram_checked_at,whatsapp_checked_at,zalo_checked_at,viber_checked_at,line_checked_at,' +
    'telegram_stale,whatsapp_stale,zalo_stale,viber_stale,line_stale',
  `0901234567,+84901234567,VN,yes,skipped,yes,skipped,skipped,${ISO},${ISO},,${ISO},,,no,,no,,`,
  `+65 9123 4567,+6591234567,SG,not_found,skipped,skipped,skipped,skipped,${ISO},${ISO},,,,,no,,,,`,
  'abc,,,invalid,invalid,invalid,invalid,invalid' + ','.repeat(11),
  '',
].join('\n');

describe('check', () => {
  it('reads the CSV, checks enabled apps and writes the report and summary', async () => {
    await run(['check', env.csv, '--out', env.out]);

    expect(readFileSync(env.out, 'utf8')).toBe(REPORT);
    expect(env.calls.sort()).toEqual(['telegram:2', 'zalo:1']);
    const summary = env.printed.join('\n');
    expect(summary).toContain('Numbers: 3 unique (2 valid, 1 invalid)');
    expect(summary).toContain('Registered (yes) by country');
    const logs = env.logs.join('\n');
    expect(logs).toContain('column "phone"');
    expect(logs).toContain('1 duplicate merged');
    expect(logs).not.toContain('+84901234567');
  });

  it('does not check numbers again on a second run', async () => {
    await run(['check', env.csv, '--out', env.out]);
    env.calls.length = 0;
    await run(['check', env.csv, '--out', env.out]);
    expect(env.calls).toEqual([]);
    expect(readFileSync(env.out, 'utf8')).toBe(REPORT);
  });

  it('re-checks everything with --max-age 0', async () => {
    await run(['check', env.csv, '--out', env.out]);
    env.calls.length = 0;
    await run(['check', env.csv, '--out', env.out, '--max-age', '0']);
    expect(env.calls.sort()).toEqual(['telegram:2', 'zalo:1']);
  });

  it('limits the apps with --apps; other columns are skipped', async () => {
    await run(['check', env.csv, '--out', env.out, '--apps', 'telegram']);
    expect(env.calls).toEqual(['telegram:2']);
    expect(readFileSync(env.out, 'utf8').split('\n')[1]).toBe(
      `0901234567,+84901234567,VN,yes,skipped,skipped,skipped,skipped,${ISO},${ISO},,,,,no,,,,`,
    );
  });

  it('picks the first phone-like column automatically and honours --column', async () => {
    writeFileSync(env.csv, 'id,first,second\n1,0901234567,0912345678\n');
    await run(['check', env.csv, '--out', env.out, '--apps', 'telegram']);
    expect(readFileSync(env.out, 'utf8').split('\n')[1]).toContain('0901234567,+84901234567,VN,yes');
    await run(['check', env.csv, '--out', env.out, '--apps', 'telegram', '--column', 'second']);
    expect(readFileSync(env.out, 'utf8').split('\n')[1]).toContain('0912345678,+84912345678,VN,yes');
  });

  describe('terminal output of untrusted CSV titles', () => {
    const ESC = String.fromCharCode(27);
    /** Control characters in this output would let a customer's file rewrite what the operator reads. */
    const FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

    function hostileCsv(title: string): string {
      return `id,"${title.replace(/"/g, '""')}"\n1,0901234567\n`;
    }

    it.each(['check', 'report'])('%s: success logging strips escapes, bidi and newlines from the phone title and caps it', async (command) => {
      const title =
        `${ESC}[2K${ESC}[1A${ESC}]0;pwned\u0007phone\u202e evil\nforged: Report written to /etc/passwd\r${ESC}[31m` + 'x'.repeat(200);
      writeFileSync(env.csv, hostileCsv(title));
      await run([command, env.csv, '--out', env.out, '--apps', 'telegram']);
      const line = env.logs.find((entry) => entry.includes('using column'));
      expect(line).toBeDefined();
      expect(line).not.toMatch(FORBIDDEN);
      expect(line).not.toContain('pwned');
      expect(line).toContain('column "phone');
      expect(line).toContain('...'); // 200 x characters: capped
      expect(line).not.toContain('x'.repeat(100));
      // one physical line: no forged second diagnostic
      expect(line!.includes('\n')).toBe(false);
    });

    it.each(['check', 'report'])('%s: success logging prints a hostile CSV/report pathname as one control-free bounded line', async (command) => {
      const hostile = `evil${ESC}[2K${ESC}]0;pwned\u0007\r\nforged: Report written to etc\u202e${ESC}[31m-${'y'.repeat(100)}.csv`;
      const csv = join(env.dir, hostile);
      const out = join(env.dir, `out${ESC}[1A\r\n\u202eforged.csv`);
      writeFileSync(csv, 'id,phone\n1,0901234567\n');
      await run([command, csv, '--out', out, '--apps', 'telegram']);
      const used = env.logs.find((entry) => entry.includes('using column'));
      const written = env.logs.find((entry) => entry.startsWith('Report written to'));
      expect(used).toBeDefined();
      expect(written).toBeDefined();
      for (const line of [used!, written!]) {
        expect(line).not.toMatch(FORBIDDEN);
        expect(line).not.toContain('pwned');
        expect(line.includes('\n')).toBe(false);
        expect(line.includes('\r')).toBe(false);
      }
      expect(used).toContain('evil');
      expect(used).toContain('forged: Report written to etc'); // text survives, but only inside this one line
      expect(used!.startsWith(env.dir.slice(0, 20))).toBe(true);
      expect(written).toContain('forged.csv');
      expect(existsSync(out)).toBe(true); // the real (hostile) path was still the one used for the file operations
    });

    it('caps a very long pathname in the success log', async () => {
      const deep = join(env.dir, 'd'.repeat(100), 'e'.repeat(100), 'f'.repeat(100), 'g'.repeat(100), 'h'.repeat(100), 'i'.repeat(100));
      mkdirSync(deep, { recursive: true });
      const csv = join(deep, 'customers.csv');
      writeFileSync(csv, 'id,phone\n1,0901234567\n');
      await run(['check', csv, '--out', env.out, '--apps', 'telegram']);
      const used = env.logs.find((entry) => entry.includes('using column'))!;
      expect(used.split(': using column')[0]!.length).toBeLessThanOrEqual(515);
      expect(used).toContain('...: using column');
    });

    it('hides a digit-heavy title (a first row that is data) instead of echoing it', async () => {
      writeFileSync(env.csv, 'Zalo 0912 345 678,x\n0901234567,y\n');
      await run(['check', env.csv, '--out', env.out, '--apps', 'telegram', '--column', '1']);
      const logs = env.logs.join('\n');
      expect(logs).not.toContain('0912');
    });

    it('an error that quotes the file never carries an escape sequence to the terminal', async () => {
      const seen: string[] = [];
      const spy = (...args: unknown[]) => void seen.push(args.join(' '));
      const original = console.error;
      console.error = spy;
      try {
        const code = await main(['--config', env.config, 'check', env.csv, '--column', `${ESC}[2Jnope\u202e`, '--out', env.out], {
          loadAdapter: async (app) => fakeAdapter(app),
          lifecycleDir: join(env.dir, 'lifecycle'),
        });
        expect(code).toBe(1);
      } finally {
        console.error = original;
      }
      expect(seen.join('\n')).toContain('not found');
      expect(seen.join('\n')).not.toMatch(FORBIDDEN);
    });
  });

  it('refuses to overwrite the input file and rejects unknown apps', async () => {
    await expect(run(['check', env.csv, '--out', env.csv])).rejects.toThrow(/differ/);
    await expect(run(['check', env.csv, '--apps', 'telegram,signal'])).rejects.toThrow(/Unknown app "signal"/);
    expect(readFileSync(env.csv, 'utf8')).toBe(CSV);
  });

  it('warns when an app has no account and leaves its column unknown', async () => {
    rmSync(join(env.dir, 'data', 'sessions', 'zalo'), { recursive: true });
    await run(['check', env.csv, '--out', env.out]);
    expect(env.logs.join('\n')).toContain('login zalo');
    expect(readFileSync(env.out, 'utf8').split('\n')[1]).toBe(
      `0901234567,+84901234567,VN,yes,skipped,unknown,skipped,skipped,${ISO},${ISO},,,,,no,,,,`,
    );
    // An app without an account is not "done": the run says so, with the reason, and still exits 0.
    const logs = env.logs.join('\n');
    expect(logs).toContain('INCOMPLETE');
    expect(logs).toContain('no_accounts');
    expect(logs).toMatch(/zalo: needed 1, attempted 0, conclusive 0, inconclusive 1/);
    expect(logs).not.toMatch(/remaining \d+ \(done\)/);
  });

  it('prints no INCOMPLETE banner when every needed check was conclusive', async () => {
    await run(['check', env.csv, '--out', env.out]);
    const logs = env.logs.join('\n');
    expect(logs).not.toContain('INCOMPLETE');
    expect(logs).toMatch(/telegram: needed 2, attempted 2, conclusive 2, inconclusive 0, no answer 0 \(all conclusive\)/);
  });

  it('fails before opening the store when no entry is a valid number', async () => {
    writeFileSync(env.csv, 'phone\nabc\n123\n');
    await expect(run(['check', env.csv, '--out', env.out])).rejects.toThrow(/no valid phone numbers \(2 invalid\)/);
    expect(existsSync(join(env.dir, 'data', 'checker.db'))).toBe(false);
    expect(existsSync(env.out)).toBe(false);
    expect(env.calls).toEqual([]);
  });

  it('says which numbers were attempted, were conclusive or stay inconclusive, and keeps an older answer', async () => {
    // Seed a 40-day-old not_found for the first number, then let the platform answer unknown for it.
    const first = '+84901234567';
    const store = Store.open(join(env.dir, 'data'));
    store.saveResults('telegram', new Map([[first, 'not_found']]), NOW - 40 * 24 * 60 * 60 * 1000);
    store.close();
    await run(['check', env.csv, '--out', env.out, '--apps', 'telegram'], {
      telegram: {
        app: 'telegram',
        async login() {},
        async open() {
          return { check: async () => new Map(), close: async () => {} };
        },
      },
    });
    const logs = env.logs.join('\n');
    expect(logs).toMatch(/telegram: needed 2, attempted 2, conclusive 0, inconclusive 2, 1 keep an older result, no answer 0 \(finished, NOT conclusive\)/);
    expect(logs).toContain('INCOMPLETE');
    expect(logs).toContain('unknown answers: 2');
    expect(logs).not.toMatch(/remaining \d+ \(done\)/);
    // The old not_found survives (an unknown never overwrites it), flagged stale with its own timestamp.
    const row = readFileSync(env.out, 'utf8').split('\n')[1]?.split(',') ?? [];
    const old = new Date(NOW - 40 * 24 * 60 * 60 * 1000).toISOString();
    expect(row[3]).toBe('not_found');
    expect(row[8]).toBe(old);
    expect(row[9]).toBe(old);
    expect(row[14]).toBe('yes');
    // The second number never got an answer: unknown, no observation time, no stale flag.
    const second = readFileSync(env.out, 'utf8').split('\n')[2]?.split(',') ?? [];
    expect(second.slice(3, 4)).toEqual(['unknown']);
    expect(second.slice(9, 14).concat(second.slice(14, 19))).toEqual(Array(10).fill(''));
  });
});

describe('report', () => {
  it('rebuilds the report from stored results without checking', async () => {
    await run(['check', env.csv, '--out', env.out]);
    rmSync(env.out);
    env.calls.length = 0;
    await run(['report', env.csv, '--out', env.out]);
    expect(env.calls).toEqual([]);
    expect(readFileSync(env.out, 'utf8')).toBe(REPORT);
  });

  it('marks results older than --max-age as stale without checking anything', async () => {
    await run(['check', env.csv, '--out', env.out]);
    rmSync(env.out);
    env.calls.length = 0;
    await run(['report', env.csv, '--out', env.out, '--max-age', '0']);
    const lines = readFileSync(env.out, 'utf8').split('\n');
    expect(lines[1]?.split(',').slice(14)).toEqual(['yes', '', 'yes', '', '']);
    expect(env.printed.join('\n')).toContain('STALE: telegram 2, zalo 1');
    expect(env.calls).toEqual([]);
  });

  it('still writes the report for an input without a valid number, but warns and exits non-zero', async () => {
    writeFileSync(env.csv, 'phone\nabc\n123\n');
    try {
      await run(['report', env.csv, '--out', env.out]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = undefined;
    }
    expect(env.logs.join('\n')).toContain('WARNING: no valid phone numbers (2 invalid)');
    expect(readFileSync(env.out, 'utf8').split('\n')).toHaveLength(4);
  });
});

describe('accounts and account-reset', () => {
  it('lists usage, shows a banned account and clears it again', async () => {
    await run(['check', env.csv, '--out', env.out], { zalo: fakeAdapter('zalo', { banned: true }) });
    expect(readFileSync(env.out, 'utf8').split('\n')[1]).toContain(',yes,skipped,unknown,skipped,skipped,');

    env.printed.length = 0;
    await run(['accounts']);
    const listing = env.printed.join('\n');
    expect(listing).toMatch(/telegram\s+a\s+ready\s+2\/200/);
    expect(listing).toMatch(/zalo\s+z\s+DISABLED: logged out/);

    env.printed.length = 0;
    await run(['account-reset', 'zalo', 'z']);
    await run(['accounts']);
    expect(env.printed.join('\n')).toMatch(/zalo\s+z\s+ready/);
  });

  it('says so when there is nothing to reset', async () => {
    await run(['account-reset', 'zalo', 'nobody']);
    expect(env.logs.join('\n')).toContain('nothing to reset');
  });

  it('rejects account names that could escape the sessions directory', async () => {
    await expect(run(['account-reset', 'zalo', '../x'])).rejects.toThrow(/Invalid account name/);
    await expect(run(['login', 'zalo', '--account', '../x'])).rejects.toThrow(/Invalid account name/);
  });
});

describe('login', () => {
  it('runs the adapter login inside the private account directory', async () => {
    await run(['login', 'telegram', '--account', 'fresh']);
    expect(existsSync(join(env.dir, 'data', 'sessions', 'telegram', 'fresh', 'creds.json'))).toBe(true);
  });

  it('removes the half-created directory when login fails', async () => {
    const adapters = { telegram: fakeAdapter('telegram', { loginFails: true }) };
    await expect(run(['login', 'telegram', '--account', 'broken'], adapters)).rejects.toThrow('OTP rejected');
    expect(existsSync(join(env.dir, 'data', 'sessions', 'telegram', 'broken'))).toBe(false);
    // an existing account directory is left alone
    await expect(run(['login', 'telegram', '--account', 'a'], adapters)).rejects.toThrow('OTP rejected');
    expect(existsSync(join(env.dir, 'data', 'sessions', 'telegram', 'a'))).toBe(true);
  });

  it('hands the login choices and the language to the adapter, defaulting to English with no choice', async () => {
    const seen: unknown[] = [];
    const adapter: Adapter = {
      ...fakeAdapter('whatsapp'),
      async login(ctx) {
        seen.push({ lang: ctx.lang, choice: ctx.loginChoice });
      },
    };
    await run(['login', 'whatsapp', '--account', 'm', '--method', 'code', '--phone', '+84901234567', '--lang', 'vi'], { whatsapp: adapter });
    await run(['login', 'whatsapp', '--account', 'm', '--method', 'QR'], { whatsapp: adapter });
    await run(['login', 'whatsapp', '--account', 'm'], { whatsapp: adapter });
    expect(seen).toEqual([
      { lang: 'vi', choice: { method: 'code', phone: '+84901234567' } },
      { lang: 'en', choice: { method: 'qr', phone: undefined } },
      { lang: 'en', choice: { method: undefined, phone: undefined } },
    ]);
  });

  it('rejects a login method other than qr or code, and keeps --lang out of the help', async () => {
    const program = createProgram({ lifecycleDir: join(env.dir, 'lifecycle'), log: () => {}, print: () => {} });
    const login = program.commands.find((command) => command.name() === 'login');
    program.exitOverride();
    login?.exitOverride();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    login?.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await expect(program.parseAsync(['--config', env.config, 'login', 'telegram', '--method', 'sms'], { from: 'user' })).rejects.toMatchObject({
      code: 'commander.invalidArgument',
    });
    expect(login?.helpInformation()).toContain('--method <method>');
    expect(login?.helpInformation()).toContain('--phone <number>');
    expect(login?.helpInformation()).not.toContain('--lang');
  });
});

describe('login robustness', () => {
  const sessionsDir = (app: string, name: string) => join(env.dir, 'data', 'sessions', app, name);
  const idleAdapter = (app: App, login: Adapter['login']): Adapter => ({ app, login, open: fakeAdapter(app).open });

  it('registers no account when login fails: no directory, no listing', async () => {
    const adapters = { telegram: fakeAdapter('telegram', { loginFails: true }) };
    await expect(run(['login', 'telegram', '--account', 'ghost'], adapters)).rejects.toThrow('OTP rejected');
    expect(existsSync(sessionsDir('telegram', 'ghost'))).toBe(false);

    env.printed.length = 0;
    await run(['accounts']);
    expect(env.printed.join('\n')).not.toContain('ghost');
  });

  it('removes the new account directory when the process is interrupted mid-login', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let began!: () => void;
    const started = new Promise<void>((resolve) => (began = resolve));
    const adapter = idleAdapter('telegram', async (ctx) => {
      writeFileSync(join(ctx.accountDir, 'partial.json'), '{}');
      began();
      await gate;
      throw new Error('aborted');
    });

    const pending = run(['login', 'telegram', '--account', 'fresh'], { telegram: adapter }).catch((e: unknown) => e);
    await started;
    expect(existsSync(sessionsDir('telegram', 'fresh'))).toBe(true);
    process.emit('SIGHUP');
    expect(existsSync(sessionsDir('telegram', 'fresh'))).toBe(false);
    expect(env.exits).toEqual([130]);
    release();
    await pending;
    expect(process.listenerCount('SIGHUP')).toBe(env.hupListeners);
  });

  it('keeps an existing account directory when an interrupted login was a re-login', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let began!: () => void;
    const started = new Promise<void>((resolve) => (began = resolve));
    const adapter = idleAdapter('telegram', async () => {
      began();
      await gate;
    });
    const pending = run(['login', 'telegram', '--account', 'a'], { telegram: adapter });
    await started;
    process.emit('SIGHUP');
    expect(existsSync(sessionsDir('telegram', 'a'))).toBe(true);
    release();
    await pending;
  });

  it('prints QR paths, URLs and pairing codes verbatim even when the account is named after a number', async () => {
    const adapter = idleAdapter('zalo', async (ctx) => {
      ctx.log(`Scan ${join(ctx.accountDir, 'qr.png')} with the Zalo app`);
      ctx.log('(or open: https://line.me/R/au/q/1234567890123?token=9876543210)');
      ctx.log('Pairing code: 1234-5678');
      writeFileSync(join(ctx.accountDir, 'creds.json'), '{}');
    });
    await run(['login', 'zalo', '--account', '0901234567'], { zalo: adapter });
    const logs = env.logs.join('\n');
    expect(logs).toContain(join(sessionsDir('zalo', '0901234567'), 'qr.png'));
    expect(logs).toContain('https://line.me/R/au/q/1234567890123?token=9876543210');
    expect(logs).toContain('Pairing code: 1234-5678');
  });

  it('refuses to log in when the data directory is a symlink', async () => {
    const real = join(env.dir, 'elsewhere');
    mkdirSync(real);
    rmSync(join(env.dir, 'data'), { recursive: true });
    symlinkSync(real, join(env.dir, 'data'));
    await expect(run(['login', 'telegram', '--account', 'x'])).rejects.toThrow(/symbolic link/);
    expect(readdirSync(real)).toEqual([]);
  });
});

describe('check run lock', () => {
  const lockFile = () => join(env.dir, 'data', 'check.lock');

  it('refuses to run next to a live check and leaves the other lock alone', async () => {
    mkdirSync(join(env.dir, 'data'), { recursive: true });
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid }));
    await expect(run(['check', env.csv, '--out', env.out])).rejects.toThrow(/already running/);
    expect(existsSync(env.out)).toBe(false);
    expect(env.calls).toEqual([]);
    expect(existsSync(lockFile())).toBe(true);
  });

  it('recovers a stale lock and always releases its own, also when the run fails', async () => {
    mkdirSync(join(env.dir, 'data'), { recursive: true });
    writeFileSync(lockFile(), JSON.stringify({ pid: 99_999_999 }));
    await run(['check', env.csv, '--out', env.out]);
    expect(existsSync(lockFile())).toBe(false);

    // A failure after the lock was taken (the report target turns bad mid-run) still releases it.
    const sabotage: Adapter = {
      app: 'telegram',
      login: async () => {},
      open: async () => ({
        async check(batch) {
          writeFileSync(env.out, 'not,a,report\n');
          return new Map<string, CheckStatus>(batch.map((n) => [n.e164, 'yes']));
        },
        async close() {},
      }),
    };
    await expect(run(['check', env.csv, '--out', env.out, '--apps', 'telegram', '--max-age', '0'], { telegram: sabotage })).rejects.toThrow(/--force/);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('refuses login and account-reset next to a live check, leaving state and the other lock alone', async () => {
    mkdirSync(join(env.dir, 'data'), { recursive: true });
    writeFileSync(lockFile(), JSON.stringify({ pid: process.pid }));
    await expect(run(['login', 'telegram', '--account', 'fresh'])).rejects.toThrow(/already running/);
    await expect(run(['login', 'telegram', '--account', 'a'])).rejects.toThrow(/already running/);
    await expect(run(['account-reset', 'telegram', 'a'])).rejects.toThrow(/already running/);
    expect(existsSync(join(env.dir, 'data', 'sessions', 'telegram', 'fresh'))).toBe(false);
    expect(existsSync(join(env.dir, 'data', 'sessions', 'telegram', 'a', 'creds.json'))).toBe(false);
    expect(existsSync(lockFile())).toBe(true);
  });

  it('holds the lock for the whole login so check, account-reset and a second login are refused, then frees it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let began!: () => void;
    const started = new Promise<void>((resolve) => (began = resolve));
    const slow: Adapter = {
      ...fakeAdapter('telegram'),
      async login(ctx) {
        began();
        await gate;
        writeFileSync(join(ctx.accountDir, 'creds.json'), '{}');
      },
    };
    const first = run(['login', 'telegram', '--account', 'fresh'], { telegram: slow });
    await started;
    expect(JSON.parse(readFileSync(lockFile(), 'utf8')).pid).toBe(process.pid);

    await expect(run(['check', env.csv, '--out', env.out])).rejects.toThrow(/already running/);
    await expect(run(['account-reset', 'telegram', 'a'])).rejects.toThrow(/already running/);
    await expect(run(['login', 'telegram', '--account', 'other'])).rejects.toThrow(/already running/);
    expect(existsSync(env.out)).toBe(false);
    expect(existsSync(join(env.dir, 'data', 'sessions', 'telegram', 'other'))).toBe(false);
    // Refused commands never remove the lock that belongs to the running login.
    expect(existsSync(lockFile())).toBe(true);

    release();
    await first;
    expect(existsSync(lockFile())).toBe(false);
    await run(['account-reset', 'telegram', 'a']);
    expect(existsSync(lockFile())).toBe(false);
  });

  it('releases the lock when login fails, is interrupted, or account-reset finds nothing', async () => {
    await expect(
      run(['login', 'telegram', '--account', 'broken'], { telegram: fakeAdapter('telegram', { loginFails: true }) }),
    ).rejects.toThrow('OTP rejected');
    expect(existsSync(lockFile())).toBe(false);

    await run(['account-reset', 'zalo', 'nobody']);
    expect(existsSync(lockFile())).toBe(false);

    const listeners = process.listenerCount('exit');
    const interrupted: Adapter = {
      ...fakeAdapter('telegram'),
      async login() {
        process.emit('SIGHUP');
      },
    };
    await run(['login', 'telegram', '--account', 'a'], { telegram: interrupted });
    expect(env.exits).toEqual([130]);
    expect(existsSync(lockFile())).toBe(false);
    expect(process.listenerCount('exit')).toBe(listeners);
  });

  it('removes the lock and keeps the signal handlers balanced after an interrupted run', async () => {
    const listeners = process.listenerCount('SIGHUP');
    const adapter: Adapter = {
      app: 'telegram',
      login: async () => {},
      open: async () => ({
        async check() {
          process.emit('SIGHUP');
          throw new AccountBanned('logged out');
        },
        async close() {},
      }),
    };
    const exitCodeBefore = process.exitCode;
    try {
      await run(['check', env.csv, '--out', env.out, '--apps', 'telegram'], { telegram: adapter });
      expect(process.exitCode).toBe(130);
    } finally {
      process.exitCode = exitCodeBefore;
    }
    expect(existsSync(lockFile())).toBe(false);
    expect(process.listenerCount('SIGHUP')).toBe(listeners);
    expect(env.logs.join('\n')).toContain('Interrupt received');
  });
});

describe('report output safety', () => {
  it('does not overwrite an unrelated file without --force', async () => {
    writeFileSync(env.out, 'name,salary\nann,1\n');
    await expect(run(['check', env.csv, '--out', env.out])).rejects.toThrow(/--force/);
    expect(readFileSync(env.out, 'utf8')).toBe('name,salary\nann,1\n');
    expect(env.calls).toEqual([]);

    await run(['check', env.csv, '--out', env.out, '--force']);
    expect(readFileSync(env.out, 'utf8')).toBe(REPORT);
  });

  it('refuses --out that is the input CSV through a hard link, even with --force', async () => {
    const alias = join(env.dir, 'alias.csv');
    linkSync(env.csv, alias);
    await expect(run(['report', env.csv, '--out', alias, '--force'])).rejects.toThrow(/must differ/);
    await expect(run(['check', env.csv, '--out', alias, '--force'])).rejects.toThrow(/must differ/);
    expect(readFileSync(env.csv, 'utf8')).toBe(CSV);
  });

  it('refuses --out inside the data directory', async () => {
    await expect(run(['report', env.csv, '--out', join(env.dir, 'data', 'report.csv'), '--force'])).rejects.toThrow(
      /data directory/,
    );
    await expect(run(['report', env.csv, '--out', join(env.dir, 'data', 'checker.db'), '--force'])).rejects.toThrow(
      /data directory/,
    );
  });

  it('writes spreadsheet-safe text for untrusted input cells', async () => {
    writeFileSync(env.csv, 'phone\n=HYPERLINK("http://x")\n0901234567\n');
    await run(['report', env.csv, '--out', env.out, '--apps', 'telegram']);
    const lines = readFileSync(env.out, 'utf8').split('\n');
    expect(lines[1]).toContain(`'=HYPERLINK`);
    expect(lines[2]).toBe('0901234567,+84901234567,VN,unknown,skipped,skipped,skipped,skipped' + ','.repeat(11));
  });
});

describe('version, doctor and app home', () => {
  const HOME_ENV = 'PHONE_APP_CHECKER_HOME';

  function program(extra: Partial<CliDeps> = {}) {
    return createProgram({
      loadAdapter: async (app) => fakeAdapter(app),
      listDevices: async () => [{ serial: 'emulator-5554', state: 'device' }],
      now: () => NOW,
      env: {},
      lifecycleDir: join(env.dir, 'lifecycle'),
      log: (message) => env.logs.push(message),
      print: (text) => env.printed.push(text),
      ...extra,
    });
  }

  async function runDoctorCommand(extra: Partial<CliDeps> = {}, args: string[] = ['--config', env.config]): Promise<number | undefined> {
    const before = process.exitCode;
    process.exitCode = undefined;
    try {
      await program(extra).parseAsync([...args, 'doctor'], { from: 'user' });
      return process.exitCode === undefined ? undefined : Number(process.exitCode);
    } finally {
      process.exitCode = before;
    }
  }

  it('--version prints the package version', async () => {
    const out: string[] = [];
    const cli = program();
    cli.exitOverride();
    cli.configureOutput({ writeOut: (text) => out.push(text), writeErr: (text) => out.push(text) });
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    await expect(cli.parseAsync(['--version'], { from: 'user' })).rejects.toMatchObject({ code: 'commander.version' });
    expect(out.join('')).toBe(`${pkg.version}\n`);
  });

  it('doctor prints one row per check and exits 0 when nothing fails', async () => {
    expect(await runDoctorCommand()).toBeUndefined();
    const text = env.printed.join('\n');
    for (const name of ['version', 'runtime', 'sqlite', 'config', 'data', 'telegram', 'whatsapp', 'zalo', 'viber', 'line']) {
      expect(text).toMatch(new RegExp(`^(OK|WARN)\\s+${name}\\s`, 'm'));
    }
    expect(text.endsWith(DOCTOR_FOOTER)).toBe(true);
    expect(text).not.toMatch(/^FAIL/m);
  });

  it('doctor exits 1 when an adapter cannot be loaded', async () => {
    const code = await runDoctorCommand({
      loadAdapter: async (app) => {
        if (app === 'zalo') throw new Error('Cannot load the zalo adapter: boom');
        return fakeAdapter(app);
      },
    });
    expect(code).toBe(1);
    expect(env.printed.join('\n')).toMatch(/^FAIL\s+zalo\s+Cannot load the zalo adapter: boom/m);
    expect(env.printed.join('\n').endsWith(DOCTOR_FOOTER)).toBe(true);
  });

  it('doctor reports a failing config instead of aborting, and exits 1', async () => {
    writeFileSync(env.config, '{ nope');
    expect(await runDoctorCommand()).toBe(1);
    expect(env.printed.join('\n')).toMatch(/^FAIL\s+config\s+Config error/m);
    expect(env.printed.join('\n').endsWith(DOCTOR_FOOTER)).toBe(true);
  });

  it('bootstraps the app home once on first use and logs it once', async () => {
    const home = join(env.dir, 'Application Support', 'phone-app-checker');
    const cli = () => program({ env: { [HOME_ENV]: home } });
    await cli().parseAsync(['accounts'], { from: 'user' });
    await cli().parseAsync(['accounts'], { from: 'user' });
    const file = join(home, 'checker.config.json');
    expect(existsSync(file)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'data', 'checker.db')).isFile()).toBe(true);
    expect(env.logs.filter((line) => line.startsWith('First run: created'))).toHaveLength(1);
    expect(env.printed).toEqual([
      'No accounts yet. Log in first (menu item 2, or run: phone-app-checker login <app> --account <name>).',
      'No accounts yet. Log in first (menu item 2, or run: phone-app-checker login <app> --account <name>).',
    ]);
  });

  it('does not bootstrap when --config is given', async () => {
    const home = join(env.dir, 'home');
    await program({ env: { [HOME_ENV]: home } }).parseAsync(['--config', env.config, 'accounts'], { from: 'user' });
    expect(existsSync(home)).toBe(false);
    expect(env.logs.some((line) => line.startsWith('First run'))).toBe(false);
  });

  it('doctor creates the home config on first run and reports it as existing', async () => {
    const home = join(env.dir, 'home');
    expect(await runDoctorCommand({ env: { [HOME_ENV]: home } }, [])).toBeUndefined();
    expect(existsSync(join(home, 'checker.config.json'))).toBe(true);
    expect(env.printed.join('\n')).toMatch(/^OK\s+config\s+.*\(exists\)/m);
  });

  it('doctor reports an unusable home as a failing config check', async () => {
    const target = join(env.dir, 'target');
    mkdirSync(target);
    const home = join(env.dir, 'link');
    symlinkSync(target, home);
    expect(await runDoctorCommand({ env: { [HOME_ENV]: home } }, [])).toBe(1);
    expect(env.printed.join('\n')).toMatch(/^FAIL\s+config\s+.*symlink/m);
  });

  describe('hidden data-dir command (used by install.sh / uninstall.sh)', () => {
    it('prints the configured dataDir resolved against the app home, without creating anything', async () => {
      const home = join(env.dir, 'home');
      mkdirSync(home);
      writeFileSync(join(home, 'checker.config.json'), JSON.stringify({ dataDir: './store' }));
      await program({ env: { [HOME_ENV]: home } }).parseAsync(['data-dir'], { from: 'user' });
      expect(env.printed).toEqual([join(home, 'store')]);
      expect(readdirSync(home)).toEqual(['checker.config.json']);
    });

    it('prints <home>/data by default, even before the home exists, and honours an absolute dataDir', async () => {
      const home = join(env.dir, 'fresh');
      await program({ env: { [HOME_ENV]: home } }).parseAsync(['data-dir'], { from: 'user' });
      expect(env.printed).toEqual([join(home, 'data')]);
      expect(existsSync(home)).toBe(false);

      const elsewhere = join(env.dir, 'elsewhere');
      writeFileSync(env.config, JSON.stringify({ dataDir: elsewhere }));
      await program().parseAsync(['--config', env.config, 'data-dir'], { from: 'user' });
      expect(env.printed[1]).toBe(elsewhere);
    });

    it('is hidden from --help', () => {
      expect(program().helpInformation()).not.toContain('data-dir');
    });
  });
});
