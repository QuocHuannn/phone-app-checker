import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdbError } from '../src/android/adb.ts';
import { loadConfig } from '../src/config.ts';
import { DOCTOR_FOOTER, formatDoctor, runDoctor, type DoctorCheck, type DoctorInput } from '../src/doctor.ts';
import { APPS, type Adapter, type App } from '../src/types.ts';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'checker-doctor-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeConfig(content: unknown): void {
  writeFileSync(join(home, 'checker.config.json'), JSON.stringify(content));
}

function addAccount(app: App, name = 'default'): void {
  mkdirSync(join(home, 'data', 'sessions', app, name), { recursive: true });
}

const fakeAdapter = (app: App): Adapter => ({
  app,
  async login() {},
  async open() {
    throw new Error('not used');
  },
});

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    home,
    configFile: join(home, 'checker.config.json'),
    configExists: true,
    loadConfig: () => loadConfig(undefined, home),
    loadAdapter: async (app) => fakeAdapter(app),
    listDevices: async () => [{ serial: 'emulator-5554', state: 'device' }],
    env: {},
    ...overrides,
  };
}

function byName(checks: DoctorCheck[]): Record<string, DoctorCheck> {
  return Object.fromEntries(checks.map((check) => [check.name, check]));
}

describe('runDoctor', () => {
  it('reports ok for a fully set up install', async () => {
    writeConfig({
      apps: { telegram: { options: { apiId: 12345, apiHash: 'abcdef' } }, viber: { enabled: true } },
    });
    for (const app of ['telegram', 'whatsapp', 'zalo', 'viber'] as const) addAccount(app);
    const checks = await runDoctor(input());
    expect(checks.map((c) => c.name)).toEqual(['version', 'runtime', 'sqlite', 'config', 'data', ...APPS]);
    expect(checks.filter((c) => c.level !== 'ok')).toEqual([]);
    const named = byName(checks);
    expect(named.version?.detail).toContain('0.1.0');
    expect(named.version?.detail).toContain('source checkout');
    expect(named.runtime?.detail).toContain(process.versions.node);
    expect(named.config?.detail).toBe(`${join(home, 'checker.config.json')} (exists)`);
    expect(named.data?.detail).toBe(join(home, 'data'));
    expect(named.line?.detail).toBe('disabled (adapter package installed)');
    expect(named.telegram?.detail).toBe('adapter package installed; 1 account');
  });

  it('fails when an adapter module cannot be loaded, even a disabled one (--deep)', async () => {
    writeConfig({});
    const checks = await runDoctor(
      input({
        deep: true,
        loadAdapter: async (app) => {
          if (app === 'line') throw new Error('Cannot load the line adapter: boom');
          return fakeAdapter(app);
        },
      }),
    );
    expect(byName(checks).line).toMatchObject({ level: 'fail', detail: 'Cannot load the line adapter: boom' });
    expect(byName(checks).whatsapp?.level).not.toBe('fail');
  });

  it('warns about enabled apps without accounts and telegram without credentials', async () => {
    writeConfig({});
    const checks = byName(await runDoctor(input()));
    expect(checks.telegram?.level).toBe('warn');
    expect(checks.telegram?.detail).toContain('no account yet: log in (menu item 2, or: phone-app-checker login telegram --account <name>)');
    expect(checks.telegram?.detail).toContain(`the menu asks for them when you log in; or set apps.telegram.options.apiId/apiHash in ${join(home, 'checker.config.json')}`);
    expect(checks.telegram?.detail).toContain('TELEGRAM_API_ID');
    expect(checks.zalo).toMatchObject({ level: 'warn' });
    expect(checks.zalo?.detail).toContain('no account yet: log in (menu item 2, or: phone-app-checker login zalo --account <name>)');
  });

  it('accepts Telegram credentials from the environment', async () => {
    writeConfig({});
    addAccount('telegram');
    const checks = byName(await runDoctor(input({ env: { TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: 'abcdef' } })));
    expect(checks.telegram).toMatchObject({ level: 'ok' });
  });

  it('fails when Viber is enabled and adb is missing', async () => {
    writeConfig({ apps: { viber: { enabled: true } } });
    addAccount('viber');
    const checks = byName(
      await runDoctor(
        input({
          listDevices: async () => {
            throw new AdbError('adb-missing', 'adb not found at "adb".');
          },
        }),
      ),
    );
    expect(checks.viber).toMatchObject({ level: 'fail' });
    expect(checks.viber?.detail).toContain('adb not found');
  });

  it('warns when Viber is enabled and no device is ready', async () => {
    writeConfig({ apps: { viber: { enabled: true } } });
    addAccount('viber');
    const checks = byName(await runDoctor(input({ listDevices: async () => [{ serial: 'X', state: 'unauthorized' }] })));
    expect(checks.viber).toMatchObject({ level: 'warn', detail: 'no Android device ready (adb devices)' });
  });

  it('passes the configured adbPath and skips adb when Viber is disabled', async () => {
    writeConfig({ apps: { viber: { enabled: true, options: { adbPath: '/opt/adb' } } } });
    addAccount('viber');
    const seen: Array<string | undefined> = [];
    await runDoctor(input({ listDevices: async (path) => (seen.push(path), [{ serial: 's', state: 'device' }]) }));
    expect(seen).toEqual(['/opt/adb']);

    writeConfig({});
    seen.length = 0;
    await runDoctor(input({ listDevices: async (path) => (seen.push(path), []) }));
    expect(seen).toEqual([]);
  });

  it('warns when the config file is missing and uses built-in defaults', async () => {
    const checks = byName(await runDoctor(input({ configExists: false })));
    expect(checks.config).toMatchObject({ level: 'warn' });
    expect(checks.config?.detail).toContain('missing: built-in defaults');
  });

  it('fails on a bad config and skips the config-dependent checks', async () => {
    writeFileSync(join(home, 'checker.config.json'), '{ nope');
    const checks = await runDoctor(input());
    expect(checks.map((c) => c.name)).toEqual(['version', 'runtime', 'sqlite', 'config']);
    expect(checks[3]).toMatchObject({ level: 'fail' });
    expect(checks[3]?.detail).toContain('Config error');
  });

  it('never prints an API hash from a broken config', async () => {
    const hash = 'abcdef0123456789abcdef0123456789';
    writeFileSync(join(home, 'checker.config.json'), `{\n  "apps": {"telegram": {"options": {"apiHash": \u201C${hash}\u201D}}}\n}`);
    const text = formatDoctor(await runDoctor(input()));
    expect(text).toContain('FAIL  config');
    expect(text).toContain('curly quotes');
    expect(text).not.toContain(hash);
    expect(text).not.toContain('abcdef0123');
  });

  it('masks long hex strings in any error detail', async () => {
    writeConfig({});
    const hash = 'abcdef0123456789abcdef0123456789';
    const checks = byName(
      await runDoctor(
        input({
          resolveAdapter: () => {
            throw new Error(`boom with ${hash} inside`);
          },
        }),
      ),
    );
    expect(checks.telegram?.detail).toBe('boom with [redacted] inside');
  });

  it('fails when the data directory is unusable', async () => {
    writeConfig({});
    const target = join(home, 'elsewhere');
    mkdirSync(target);
    symlinkSync(target, join(home, 'data'));
    const checks = byName(await runDoctor(input()));
    expect(checks.data?.level).toBe('fail');
  });

  it('default doctor resolves adapter packages and never imports an adapter module', async () => {
    writeConfig({});
    const resolved: App[] = [];
    const loaded: App[] = [];
    const checks = await runDoctor(
      input({
        resolveAdapter: (app) => {
          resolved.push(app);
        },
        loadAdapter: async (app) => {
          loaded.push(app);
          return fakeAdapter(app);
        },
      }),
    );
    expect(resolved).toEqual([...APPS]);
    expect(loaded).toEqual([]);
    expect(byName(checks).whatsapp).toMatchObject({ level: 'warn' });
  });

  it('--deep loads every adapter module instead of resolving packages', async () => {
    writeConfig({});
    const loaded: App[] = [];
    const resolved: App[] = [];
    await runDoctor(
      input({
        deep: true,
        resolveAdapter: (app) => {
          resolved.push(app);
        },
        loadAdapter: async (app) => {
          loaded.push(app);
          return fakeAdapter(app);
        },
      }),
    );
    expect(loaded).toEqual([...APPS]);
    expect(resolved).toEqual([]);
  });

  it('fails an app whose adapter package cannot be resolved (shallow)', async () => {
    writeConfig({});
    const checks = await runDoctor(
      input({
        resolveAdapter: (app) => {
          if (app === 'zalo') throw new Error(`Cannot find module 'zca-js'`);
        },
      }),
    );
    expect(byName(checks).zalo).toMatchObject({ level: 'fail' });
    expect(byName(checks).zalo?.detail).toContain("Cannot find module 'zca-js'");
    expect(byName(checks).telegram?.level).not.toBe('fail');
  });
});

describe('formatDoctor', () => {
  it('aligns level, name and detail columns', () => {
    const text = formatDoctor([
      { name: 'sqlite', level: 'ok', detail: 'fine' },
      { name: 'config', level: 'warn', detail: 'missing' },
      { name: 'telegram', level: 'fail', detail: 'broken' },
    ]);
    expect(text.split('\n').slice(0, 3)).toEqual([
      'OK    sqlite    fine',
      'WARN  config    missing',
      'FAIL  telegram  broken',
    ]);
  });

  it('always ends with the offline-only footer, verbatim', () => {
    expect(DOCTOR_FOOTER.split('\n')).toEqual([
      'NOTE: doctor checks offline readiness only (no live account authentication).',
      'OK does not prove an account can check numbers: run `phone-app-checker login <app> --account <name>`,',
      'then a small trial on numbers whose answers you already know, before trusting any result.',
    ]);
    for (const checks of [[], [{ name: 'config', level: 'fail' as const, detail: 'broken' }]]) {
      const text = formatDoctor(checks);
      expect(text.endsWith(`\n\n${DOCTOR_FOOTER}`)).toBe(true);
    }
  });

  it('wraps a long fix instruction to the window with a hanging indent and loses no word', () => {
    const detail = 'no account yet: log in (menu item 2, or: phone-app-checker login telegram --account <name>); api_id/api_hash: the menu asks for them when you log in';
    const prefix = 'WARN  telegram  ';
    for (const columns of [40, 60, 80]) {
      const rows = formatDoctor([{ name: 'telegram', level: 'warn', detail }], columns).split('\n\n')[0]?.split('\n') ?? [];
      expect(rows.length).toBeGreaterThan(1);
      for (const row of rows) expect(row.length).toBeLessThanOrEqual(columns);
      expect(rows[0]?.startsWith(prefix)).toBe(true);
      for (const row of rows.slice(1)) expect(row.startsWith(' '.repeat(prefix.length))).toBe(true);
      const words = (text: string): string[] => text.split(/\s+/).filter((word) => word !== '');
      expect(words(rows.join(' ').replace(prefix.trim(), ''))).toEqual(words(detail));
    }
  });

  it('puts the footer in its own paragraph after a blank line', () => {
    const text = formatDoctor([{ name: 'data', level: 'ok', detail: 'fine' }], 40);
    expect(text.split('\n\n')).toHaveLength(2);
    expect(text.endsWith(DOCTOR_FOOTER)).toBe(true);
  });
});

describe('wording shared with the install guide and install.sh', () => {
  const root = join(import.meta.dirname, '..');
  const guide = readFileSync(join(root, 'docs', 'install-macos.vi.md'), 'utf8');
  const installer = readFileSync(join(root, 'release', 'install.sh'), 'utf8');

  it('the Vietnamese guide quotes the doctor footer verbatim', () => {
    expect(guide).toContain(`\`\`\`\n${DOCTOR_FOOTER}\n\`\`\``);
  });

  it('the guide quotes the install.sh summary lines that qualify success and failure', () => {
    const ready = 'Đã chép file / Files installed: phone-app-checker 0.1.0 (doctor: không có FAIL / no FAIL)';
    const trust = 'NOT yet trustworthy: doctor checks offline readiness only. Run login, then a small trial with known-truth numbers.';
    const notReady = 'CHƯA SẴN SÀNG / NOT READY: phone-app-checker 0.1.0 đã được chép vào máy nhưng doctor báo FAIL (mã / exit 1).';
    for (const line of [ready, trust, notReady]) expect(guide).toContain(line);
    expect(installer).toContain(ready.replace('0.1.0', '%s'));
    expect(installer).toContain(trust);
    expect(installer).toContain('CHƯA SẴN SÀNG / NOT READY: phone-app-checker %s đã được chép vào máy nhưng doctor báo FAIL (mã / exit %s).');
  });
});
