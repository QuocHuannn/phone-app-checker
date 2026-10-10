import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountDirPath,
  assertAccountName,
  CURRENT_CONFIG_VERSION,
  DEFAULT_APPS,
  ensureAccountDir,
  listAccountNames,
  loadConfig,
} from '../src/config.ts';
import { APPS } from '../src/types.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'checker-config-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(content: unknown): string {
  const path = join(dir, 'checker.config.json');
  writeFileSync(path, JSON.stringify(content));
  return path;
}

describe('loadConfig', () => {
  it('has conservative defaults for an empty config file', () => {
    const config = loadConfig(write({}));
    expect(config.defaultRegion).toBe('VN');
    expect(config.maxAgeDays).toBe(30);
    expect(config.apps.telegram.enabled).toBe(true);
    expect(config.apps.viber.enabled).toBe(false);
    expect(config.apps.line.enabled).toBe(false);
  });

  it('overlays only the settings present in the file', () => {
    const config = loadConfig(
      write({
        defaultRegion: 'SG',
        dataDir: join(dir, 'd'),
        maxAgeDays: 7,
        apps: { telegram: { dailyCap: 5, options: { apiId: 1 } }, viber: { enabled: true } },
      }),
    );
    expect(config).toMatchObject({ defaultRegion: 'SG', dataDir: join(dir, 'd'), maxAgeDays: 7 });
    expect(config.apps.telegram).toMatchObject({ dailyCap: 5, batchSize: DEFAULT_APPS.telegram.batchSize, options: { apiId: 1 } });
    expect(config.apps.viber.enabled).toBe(true);
    expect(DEFAULT_APPS.telegram.dailyCap).not.toBe(5);
    expect(DEFAULT_APPS.telegram.options).toEqual({});
  });

  it('the shipped example config is valid, matches the pacing defaults and documents every adapter option', () => {
    const example = loadConfig(fileURLToPath(new URL('../checker.config.example.json', import.meta.url)));
    for (const app of APPS) {
      const { options, ...pacing } = example.apps[app];
      const { options: _defaults, ...defaultPacing } = DEFAULT_APPS[app];
      expect(pacing).toEqual(defaultPacing);
      expect(typeof options).toBe('object');
    }
    expect(Object.keys(example.apps.viber.options)).toEqual(
      expect.arrayContaining(['registeredQuery', 'syncedQuery', 'authQuery']),
    );
    expect(Object.keys(example.apps.telegram.options)).toEqual(expect.arrayContaining(['apiId', 'apiHash']));
  });

  it.each([
    [{ defaultRegion: 'vietnam' }, /defaultRegion/],
    [{ maxAgeDays: -1 }, /maxAgeDays/],
    [{ typo: 1 }, /unknown setting "typo"/],
    [{ apps: { signal: {} } }, /unknown app "signal"/],
    [{ apps: { telegram: { dailycap: 5 } } }, /unknown setting "dailycap"/],
    [{ apps: { telegram: { dailyCap: 0 } } }, /dailyCap must be >= 1/],
    [{ apps: { telegram: { batchSize: 'big' } } }, /batchSize must be a non-negative number/],
    [{ apps: { telegram: { rateLimitCooldownMs: 0 } } }, /rateLimitCooldownMs must be >= 1/],
    [{ apps: { telegram: { enabled: 'yes' } } }, /enabled must be true\/false/],
    [{ apps: { telegram: { maxParallelAccounts: 0 } } }, /maxParallelAccounts must be a whole number >= 1/],
    [{ apps: { telegram: { maxParallelAccounts: 1.5 } } }, /maxParallelAccounts must be a whole number >= 1/],
    [{ apps: { telegram: { maxParallelAccounts: '2' } } }, /maxParallelAccounts must be a whole number >= 1/],
    [{ apps: { viber: { maxParallelAccounts: 2 } } }, /apps\.viber\.maxParallelAccounts must be 1.*one Android device|apps\.viber\.maxParallelAccounts must be 1/],
    [[], /JSON object/],
  ])('rejects invalid config %j', (content, message) => {
    expect(() => loadConfig(write(content))).toThrow(message);
  });

  it('runs one account at a time unless maxParallelAccounts is raised, and accepts it for every app but Viber', () => {
    const config = loadConfig(write({ apps: { telegram: { maxParallelAccounts: 3 }, viber: { maxParallelAccounts: 1 } } }));
    expect(config.apps.telegram.maxParallelAccounts).toBe(3);
    expect(config.apps.whatsapp.maxParallelAccounts).toBe(1);
    expect(config.apps.viber.maxParallelAccounts).toBe(1);
    expect(DEFAULT_APPS.telegram.maxParallelAccounts).toBe(1);
  });

  it('fails clearly when an explicitly named file is missing', () => {
    expect(() => loadConfig(join(dir, 'nope.json'))).toThrow(/not found/);
  });

  it('fails clearly on malformed JSON', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, '{ nope');
    expect(() => loadConfig(path)).toThrow(/Config error/);
  });

  it('reports a JSON syntax error by position only, never quoting the file (API hashes)', () => {
    const path = join(dir, 'secret.json');
    const hash = '0123456789abcdef0123456789abcdef';
    writeFileSync(path, `{\n  "apps": {"telegram": {"options": {"apiHash": "${hash}",}}}\n}`);
    let message = '';
    try {
      loadConfig(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/not valid JSON at line 2, column \d+/);
    expect(message).not.toContain(hash);
    expect(message).not.toContain('0123456789');
  });

  it('points at curly quotes (TextEdit smart quotes) without echoing the value', () => {
    const path = join(dir, 'curly.json');
    writeFileSync(path, '{\n  "defaultRegion": \u201CSG\u201D\n}');
    let message = '';
    try {
      loadConfig(path);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('curly quotes at line 2, column 20');
    expect(message).not.toContain('SG');
  });
});

describe('loadConfig home mode', () => {
  function writeIn(base: string, content: unknown, name = 'checker.config.json'): string {
    mkdirSync(base, { recursive: true });
    const path = join(base, name);
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it('reads <home>/checker.config.json and anchors a relative dataDir at home', () => {
    const home = join(dir, 'home');
    writeIn(home, { defaultRegion: 'SG', dataDir: './store' });
    const config = loadConfig(undefined, home);
    expect(config.defaultRegion).toBe('SG');
    expect(config.dataDir).toBe(join(home, 'store'));
  });

  it('defaults dataDir to <home>/data and uses built-in defaults when the file is absent', () => {
    const home = join(dir, 'home');
    const config = loadConfig(undefined, home);
    expect(config.dataDir).toBe(join(home, 'data'));
    expect(config.defaultRegion).toBe('VN');
  });

  it('keeps an absolute dataDir unchanged', () => {
    const home = join(dir, 'home');
    const absolute = join(dir, 'elsewhere');
    writeIn(home, { dataDir: absolute });
    expect(loadConfig(undefined, home).dataDir).toBe(absolute);
  });

  it('resolves an explicit path against cwd but still anchors dataDir at home', () => {
    const home = join(dir, 'home');
    const cwd = join(dir, 'cwd');
    writeIn(home, { defaultRegion: 'SG' });
    writeIn(cwd, { defaultRegion: 'TH' }, 'other.json');
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      const config = loadConfig('other.json', home);
      expect(config.defaultRegion).toBe('TH');
      expect(config.dataDir).toBe(join(home, 'data'));
      expect(() => loadConfig('missing.json', home)).toThrow(/not found/);
    } finally {
      spy.mockRestore();
    }
  });

  it('source mode (no home) still resolves the default file and dataDir against cwd', () => {
    const cwd = join(dir, 'cwd');
    writeIn(cwd, { defaultRegion: 'SG', dataDir: './d' });
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    try {
      const config = loadConfig();
      expect(config.defaultRegion).toBe('SG');
      expect(config.dataDir).toBe(join(cwd, 'd'));
    } finally {
      spy.mockRestore();
    }
  });

  it('supports a home path containing a space', () => {
    const home = join(dir, 'Application Support', 'phone-app-checker');
    writeIn(home, { defaultRegion: 'SG' });
    const config = loadConfig(undefined, home);
    expect(config.defaultRegion).toBe('SG');
    expect(config.dataDir).toBe(join(home, 'data'));
  });
});

describe('loadConfig configVersion migration', () => {
  const FIXTURE = fileURLToPath(new URL('./fixtures/v0.1.0/checker.config.json', import.meta.url));
  const hush = () => vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  it('upgrades the shipped 0.1.0 config in place, keeps a mode-600 backup and says so once', () => {
    const file = join(dir, 'checker.config.json');
    copyFileSync(FIXTURE, file);
    const original = readFileSync(file, 'utf8');
    const stderr = hush();
    try {
      const config = loadConfig(file);
      expect(config.defaultRegion).toBe('VN');
      expect(config.apps.telegram.batchSize).toBe(10);
      expect(config.apps.telegram.options).toEqual({ apiId: null, apiHash: null });

      const backup = `${file}.v1.bak`;
      expect(readFileSync(backup, 'utf8')).toBe(original);
      expect(statSync(backup).mode & 0o777).toBe(0o600);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ configVersion: CURRENT_CONFIG_VERSION, ...JSON.parse(original) });
      expect(stderr.mock.calls.map((call) => String(call[0])).join('')).toContain(backup);
    } finally {
      stderr.mockRestore();
    }
  });

  it('is a no-op on the second load: file unchanged, no extra backup, no message', () => {
    const file = join(dir, 'checker.config.json');
    copyFileSync(FIXTURE, file);
    const stderr = hush();
    try {
      loadConfig(file);
      stderr.mockClear();
      const migrated = readFileSync(file, 'utf8');
      loadConfig(file);
      expect(readFileSync(file, 'utf8')).toBe(migrated);
      expect(readdirSync(dir).sort()).toEqual(['checker.config.json', 'checker.config.json.v1.bak']);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it('never overwrites an existing backup: the next migration takes a suffixed name', () => {
    const file = join(dir, 'checker.config.json');
    copyFileSync(FIXTURE, file);
    const stderr = hush();
    try {
      loadConfig(file);
      writeFileSync(file, JSON.stringify({ maxAgeDays: 7 }));
      loadConfig(file);
      expect(readFileSync(`${file}.v1.bak`, 'utf8')).toContain('"zalo"');
      expect(readFileSync(`${file}.v1-2.bak`, 'utf8')).toBe(JSON.stringify({ maxAgeDays: 7 }));
    } finally {
      stderr.mockRestore();
    }
  });

  it('refuses a file that needs a newer program without touching it', () => {
    const file = write({ configVersion: CURRENT_CONFIG_VERSION + 1 });
    const before = readFileSync(file, 'utf8');
    expect(() => loadConfig(file)).toThrow(/needs a newer version/);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['checker.config.json']);
  });

  it.each([[2.5], ['2'], [0], [-1], [null]])('rejects a malformed configVersion %j', (version) => {
    expect(() => loadConfig(write({ configVersion: version }))).toThrow(/configVersion must be a whole number/);
  });

  it('still rejects unknown keys after the in-memory upgrade, leaving the file alone', () => {
    const file = write({ typo: 1 });
    const before = readFileSync(file, 'utf8');
    expect(() => loadConfig(file)).toThrow(/unknown setting "typo"/);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['checker.config.json']);
  });

  it('leaves a current file byte-identical (no backup, no rewrite, no message)', () => {
    const file = write({ configVersion: CURRENT_CONFIG_VERSION, defaultRegion: 'SG' });
    const before = readFileSync(file, 'utf8');
    const stderr = hush();
    try {
      expect(loadConfig(file).defaultRegion).toBe('SG');
      expect(readFileSync(file, 'utf8')).toBe(before);
      expect(readdirSync(dir)).toEqual(['checker.config.json']);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('account directories', () => {
  const config = () => loadConfig(write({ dataDir: join(dir, 'data') }));

  it('validates account names', () => {
    for (const ok of ['a', 'sim-1', 'Sim_2', 'x'.repeat(32)]) expect(() => assertAccountName(ok)).not.toThrow();
    for (const bad of ['', '../x', 'a/b', '.hidden', '-lead', 'x'.repeat(33), 'sp ace']) {
      expect(() => assertAccountName(bad)).toThrow(/Invalid account name/);
    }
  });

  it('creates private directories under <dataDir>/sessions/<app>/<name> and lists them sorted', () => {
    const cfg = config();
    const created = ensureAccountDir(cfg, 'telegram', 'b');
    ensureAccountDir(cfg, 'telegram', 'a');
    expect(created).toBe(accountDirPath(cfg, 'telegram', 'b'));
    expect(created).toBe(join(dir, 'data', 'sessions', 'telegram', 'b'));
    expect(statSync(created).mode & 0o077).toBe(0);
    expect(listAccountNames(cfg, 'telegram')).toEqual(['a', 'b']);
    expect(listAccountNames(cfg, 'zalo')).toEqual([]);
  });

  it('ignores stray files and directories with unsafe names', () => {
    const cfg = config();
    const root = join(dir, 'data', 'sessions', 'zalo');
    mkdirSync(join(root, '.cache'), { recursive: true });
    mkdirSync(join(root, 'good'), { recursive: true });
    writeFileSync(join(root, 'notes.txt'), 'x');
    expect(listAccountNames(cfg, 'zalo')).toEqual(['good']);
  });
});
