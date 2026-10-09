import { spawn, spawnSync, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram } from '../src/cli.ts';
import { LIFECYCLE_BARRIER, LIFECYCLE_SHARED, lifecycleDir } from '../src/lock.ts';
import { SHARED_USER_DIRS } from '../src/paths.ts';

const RELEASE_DIR = resolve('release');
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const BEGIN = '# >>> phone-app-checker >>>';
const END = '# <<< phone-app-checker <<<';

/** Prints what the wrapper handed to the app and records every invocation in $STUB_LOG. */
const STUB_APP = `
const fs = require('node:fs');
const record = {
  argv: process.argv.slice(2),
  home: process.env.PHONE_APP_CHECKER_HOME,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  nodePath: process.env.NODE_PATH ?? null,
};
if (process.argv[2] === 'data-dir' && process.env.STUB_DATA_DIR) {
  console.log(process.env.STUB_DATA_DIR);
  process.exit(0);
}
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(record) + '\\n');
console.log(JSON.stringify(record));
process.exit(Number(process.env.STUB_EXIT ?? 0));
`;

let root: string;
let home: string;
let stubDir: string;
let log: string;
let defaultHome: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'release-scripts-'));
  home = join(root, 'home');
  stubDir = join(root, 'stubs');
  log = join(root, 'stub.log');
  mkdirSync(home);
  mkdirSync(stubDir);
  defaultHome = join(home, 'Library', 'Application Support', 'phone-app-checker');
  fakeSystem('arm64', '14.5');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** PATH-prepended uname/sw_vers so guards are deterministic on any host. */
function fakeSystem(arch: string, macos: string): void {
  executable(
    join(stubDir, 'uname'),
    `if [ "$1" = "-m" ]; then echo ${arch}; else exec /usr/bin/uname "$@"; fi`,
  );
  executable(join(stubDir, 'sw_vers'), `echo ${macos}`);
}

/** Minimal bundle with the real scripts, a stub app and the current Node as runtime. */
function makeBundle(version: string, name = `bundle-${version}`): string {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'runtime', 'bin'), { recursive: true });
  mkdirSync(join(dir, 'app', 'bin'), { recursive: true });
  writeFileSync(join(dir, 'VERSION'), `${version}\n`.trim());
  symlinkSync(process.execPath, join(dir, 'runtime', 'bin', 'node'));
  writeFileSync(join(dir, 'app', 'bin', 'phone-app-checker.js'), STUB_APP);
  for (const file of ['phone-app-checker', 'install.sh', 'uninstall.sh']) {
    copyFileSync(join(RELEASE_DIR, file), join(dir, file));
    chmodSync(join(dir, file), 0o755);
  }
  return dir;
}

/** Like makeBundle, but the app is the real CLI from this checkout (for the `data-dir` handshake). */
function realCliBundle(version: string, name = 'real-cli'): string {
  const dir = makeBundle(version, name);
  const entry = pathToFileURL(resolve('bin', 'phone-app-checker.js')).href;
  writeFileSync(join(dir, 'app', 'bin', 'phone-app-checker.js'), `import(${JSON.stringify(entry)});\n`);
  return dir;
}

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: `${stubDir}:${SYSTEM_PATH}`,
    SHELL: '/bin/zsh',
    STUB_LOG: log,
    ...extra,
  };
}

function run(
  script: string,
  args: string[] = [],
  opts: { env?: Record<string, string>; input?: string } = {},
) {
  const result = spawnSync(script.endsWith('.sh') ? '/bin/bash' : script, script.endsWith('.sh') ? [script, ...args] : args, {
    env: baseEnv(opts.env),
    encoding: 'utf8',
    input: opts.input ?? '',
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

type Call = { argv: string[]; home?: string; nodeOptions: string | null; nodePath: string | null };

function logged(): Call[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const base = (): string => join(home, 'Applications', 'phone-app-checker');
const command = (): string => join(home, '.local', 'bin', 'phone-app-checker');
const zprofile = (): string => join(home, '.zprofile');
const count = (text: string, needle: string): number => text.split(needle).length - 1;

function install(bundle: string, env: Record<string, string> = {}) {
  return run(join(bundle, 'install.sh'), [], { env });
}

function lock(): string {
  const dir = join(defaultHome, 'data');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'check.lock');
  writeFileSync(file, '1');
  return file;
}

describe.skipIf(process.platform !== 'darwin')('release scripts', () => {
  describe('install.sh', () => {
    it('installs from an extracted bundle: version dir, current, command link, one PATH block, self-check', () => {
      const bundle = makeBundle('0.1.0');
      const result = install(bundle);
      expect(result.status, result.stderr).toBe(0);

      // .created-profiles remembers that this run created ~/.zprofile (uninstall may delete it again while empty)
      expect(readdirSync(base()).sort()).toEqual(['.created-profiles', '0.1.0', 'current']);
      expect(readlinkSync(join(base(), 'current'))).toBe('0.1.0');
      expect(lstatSync(command()).isSymbolicLink()).toBe(true);
      expect(readlinkSync(command())).toBe(join(base(), 'current', 'phone-app-checker'));
      expect(existsSync(join(base(), '0.1.0', 'runtime', 'bin', 'node'))).toBe(true);

      const profile = readFileSync(zprofile(), 'utf8');
      expect(count(profile, BEGIN)).toBe(1);
      expect(profile).toContain('export PATH="$HOME/.local/bin:$PATH"');

      const calls = logged();
      expect(calls.map((c) => c.argv)).toEqual([['--version'], ['doctor', '--deep']]);
      expect(result.stdout).toContain(join(defaultHome, 'checker.config.json'));
      expect(result.stdout).toContain('0.1.0');
      // A clean doctor is still only an offline check: the summary says so and never claims readiness.
      expect(result.stdout).toContain('Files installed: phone-app-checker 0.1.0 (doctor: không có FAIL / no FAIL)');
      expect(result.stdout).toContain('NOT yet trustworthy: doctor checks offline readiness only');
      expect(result.stdout).not.toContain('NOT READY');
    });

    it('does not fail the install when doctor exits non-zero, but fails when --version fails', () => {
      const bundle = makeBundle('0.1.0');
      writeFileSync(
        join(bundle, 'app', 'bin', 'phone-app-checker.js'),
        `if (process.argv[2] === 'doctor') process.exit(1); console.log('0.1.0');`,
      );
      const failed = install(bundle);
      expect(failed.status).toBe(0);
      // Exit stays 0 (files are installed and --version works) but the summary must not read as success.
      expect(failed.stdout).toContain('CHƯA SẴN SÀNG / NOT READY: phone-app-checker 0.1.0');
      expect(failed.stdout).toContain('doctor báo FAIL (mã / exit 1)');
      expect(failed.stdout).toContain('Fix every FAIL above');
      expect(failed.stdout).not.toContain('Files installed');
      expect(failed.stdout).not.toContain('no FAIL');

      const broken = makeBundle('0.2.0');
      writeFileSync(join(broken, 'app', 'bin', 'phone-app-checker.js'), 'process.exit(3);');
      const result = install(broken);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--version');
    });

    it('is idempotent: reinstalling the same version keeps one PATH block', () => {
      const bundle = makeBundle('0.1.0');
      expect(install(bundle).status).toBe(0);
      writeFileSync(join(base(), '0.1.0', 'stale-file'), 'x');
      expect(install(bundle).status).toBe(0);

      expect(count(readFileSync(zprofile(), 'utf8'), BEGIN)).toBe(1);
      expect(existsSync(join(base(), '0.1.0', 'stale-file'))).toBe(false);
      expect(readlinkSync(join(base(), 'current'))).toBe('0.1.0');
    });

    it('updates to a newer version, keeps the old one and rolls back without copying', () => {
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      const marker = join(base(), '0.1.0', 'marker');
      writeFileSync(marker, 'still here');

      const update = install(makeBundle('0.1.1'));
      expect(update.status, update.stderr).toBe(0);
      expect(readlinkSync(join(base(), 'current'))).toBe('0.1.1');
      expect(readdirSync(base()).sort()).toEqual(['.created-profiles', '0.1.0', '0.1.1', 'current']);
      expect(update.stdout).toContain(`rm -rf "${join(base(), '0.1.0')}"`);

      const rollback = run(join(base(), '0.1.0', 'install.sh'));
      expect(rollback.status, rollback.stderr).toBe(0);
      expect(readlinkSync(join(base(), 'current'))).toBe('0.1.0');
      expect(readFileSync(marker, 'utf8')).toBe('still here');
      expect(readdirSync(base()).sort()).toEqual(['.created-profiles', '0.1.0', '0.1.1', 'current']);
    });

    it('clears com.apple.quarantine from the installed copy', () => {
      const bundle = makeBundle('0.1.0');
      const value = '0081;5f5e1000;Safari;';
      for (const file of [join(bundle, 'VERSION'), join(bundle, 'app', 'bin', 'phone-app-checker.js')]) {
        const set = spawnSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, file], { encoding: 'utf8' });
        expect(set.status, set.stderr).toBe(0);
      }
      const before = spawnSync('/usr/bin/xattr', ['-lr', bundle], { encoding: 'utf8' });
      expect(before.stdout).toContain('com.apple.quarantine');

      const result = install(bundle);
      expect(result.status, result.stderr).toBe(0);
      const after = spawnSync('/usr/bin/xattr', ['-lr', join(base(), '0.1.0')], { encoding: 'utf8' });
      expect(after.stdout).not.toContain('com.apple.quarantine');
    });

    it('refuses to replace a version while a check holds the lock', () => {
      const bundle = makeBundle('0.1.0');
      expect(install(bundle).status).toBe(0);
      writeFileSync(join(base(), '0.1.0', 'marker'), 'x');
      lock();

      const result = install(bundle);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('check.lock');
      expect(existsSync(join(base(), '0.1.0', 'marker'))).toBe(true);
    });

    it('honours a preset PHONE_APP_CHECKER_HOME for the lock check and the printed config path', () => {
      const custom = join(root, 'custom home');
      mkdirSync(join(custom, 'data'), { recursive: true });
      const bundle = makeBundle('0.1.0');
      const first = install(bundle, { PHONE_APP_CHECKER_HOME: custom });
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain(join(custom, 'checker.config.json'));
      expect(logged()[0]?.home).toBe(custom);

      writeFileSync(join(custom, 'data', 'check.lock'), '1');
      expect(install(bundle, { PHONE_APP_CHECKER_HOME: custom }).status).toBe(1);
    });

    describe('run lock in a configured dataDir', () => {
      function seedStore(): string {
        const store = join(defaultHome, 'store');
        mkdirSync(store, { recursive: true });
        writeFileSync(join(defaultHome, 'checker.config.json'), JSON.stringify({ dataDir: './store' }));
        const lockFile = join(store, 'check.lock');
        writeFileSync(lockFile, JSON.stringify({ pid: 1 }));
        return lockFile;
      }

      it("refuses to replace a version while a run holds <home>/store/check.lock (dataDir './store')", () => {
        const bundle = makeBundle('0.1.0');
        expect(install(bundle).status).toBe(0);
        writeFileSync(join(base(), '0.1.0', 'marker'), 'x');
        const lockFile = seedStore();

        const result = install(bundle);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(lockFile);
        expect(existsSync(join(base(), '0.1.0', 'marker'))).toBe(true);

        rmSync(lockFile);
        expect(install(bundle).status).toBe(0);
        expect(existsSync(join(base(), '0.1.0', 'marker'))).toBe(false);
      });

      it('asks the installed CLI for the data directory: a lock in an absolute dataDir outside the home is honoured', () => {
        expect(install(makeBundle('0.1.0')).status).toBe(0);
        writeFileSync(join(base(), '0.1.0', 'marker'), 'x');
        const elsewhere = join(root, 'elsewhere');
        mkdirSync(elsewhere);
        writeFileSync(join(elsewhere, 'check.lock'), JSON.stringify({ pid: 1 }));

        const refused = install(makeBundle('0.1.0', 'again'), { STUB_DATA_DIR: elsewhere });
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain(join(elsewhere, 'check.lock'));
        expect(existsSync(join(base(), '0.1.0', 'marker'))).toBe(true);
      });

      it('the real CLI answers `data-dir` from checker.config.json (absolute dataDir outside the home)', () => {
        expect(install(realCliBundle('0.1.0')).status).toBe(0);
        writeFileSync(join(base(), '0.1.0', 'marker'), 'x');
        const elsewhere = join(root, 'elsewhere');
        mkdirSync(elsewhere);
        writeFileSync(join(defaultHome, 'checker.config.json'), JSON.stringify({ dataDir: elsewhere }));
        writeFileSync(join(elsewhere, 'check.lock'), JSON.stringify({ pid: 1 }));

        const refused = install(realCliBundle('0.1.0', 'real-again'));
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain(join(elsewhere, 'check.lock'));
        expect(existsSync(join(base(), '0.1.0', 'marker'))).toBe(true);

        rmSync(join(elsewhere, 'check.lock'));
        expect(install(realCliBundle('0.1.0', 'real-again')).status).toBe(0);
        expect(existsSync(join(base(), '0.1.0', 'marker'))).toBe(false);
      });
    });

    it('skips the PATH block when ~/.local/bin is already on PATH and reuses an existing block', () => {
      const withPath = install(makeBundle('0.1.0'), { PATH: `${join(home, '.local', 'bin')}:${stubDir}:${SYSTEM_PATH}` });
      expect(withPath.status, withPath.stderr).toBe(0);
      expect(existsSync(zprofile())).toBe(false);

      writeFileSync(zprofile(), `${BEGIN}\nexport PATH="$HOME/.local/bin:$PATH"\n${END}\n`);
      expect(install(makeBundle('0.1.0', 'again')).status).toBe(0);
      expect(count(readFileSync(zprofile(), 'utf8'), BEGIN)).toBe(1);
    });

    it('uses .bash_profile for bash and only prints a manual line for other shells', () => {
      expect(install(makeBundle('0.1.0'), { SHELL: '/bin/bash' }).status).toBe(0);
      expect(count(readFileSync(join(home, '.bash_profile'), 'utf8'), BEGIN)).toBe(1);
      expect(existsSync(zprofile())).toBe(false);

      rmSync(join(home, '.bash_profile'));
      const fish = install(makeBundle('0.1.0', 'fish'), { SHELL: '/usr/local/bin/fish' });
      expect(fish.status).toBe(0);
      expect(existsSync(join(home, '.bash_profile'))).toBe(false);
      expect(existsSync(zprofile())).toBe(false);
      expect(fish.stdout).toContain('export PATH=');
    });

    it('refuses Intel / Rosetta and macOS older than 13.5', () => {
      fakeSystem('x86_64', '14.5');
      const intel = install(makeBundle('0.1.0'));
      expect(intel.status).toBe(1);
      expect(intel.stderr).toContain('arm64');

      fakeSystem('arm64', '12.7');
      const old = install(makeBundle('0.1.0', 'old'));
      expect(old.status).toBe(1);
      expect(old.stderr).toContain('13.5');

      fakeSystem('arm64', '13.4.1');
      expect(install(makeBundle('0.1.0', 'old2')).status).toBe(1);

      expect(existsSync(base())).toBe(false);
      expect(existsSync(command())).toBe(false);

      for (const ok of ['13.5', '13.6.2', '14.0', '26.0']) {
        fakeSystem('arm64', ok);
        const result = install(makeBundle('0.1.0', `ok-${ok}`));
        expect(result.status, `${ok}: ${result.stderr}`).toBe(0);
      }
    });

    it('refuses when the macOS version is empty or not numeric (the 13.5 guard cannot be bypassed)', () => {
      for (const version of ['', 'beta', '14.x', '.5']) {
        fakeSystem('arm64', version);
        const result = install(makeBundle('0.1.0', `bad-${version || 'empty'}`));
        expect(result.status, `'${version}'`).toBe(1);
        expect(result.stderr, `'${version}'`).toContain('macOS');
        expect(existsSync(base())).toBe(false);
        expect(existsSync(command())).toBe(false);
      }
    });

    it('never overwrites a foreign ~/.local/bin/phone-app-checker, but replaces its own link', () => {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      writeFileSync(command(), '#!/bin/sh\necho mine\n');
      const file = install(makeBundle('0.1.0'));
      expect(file.status).toBe(1);
      expect(file.stderr).toContain(command());
      expect(readFileSync(command(), 'utf8')).toContain('mine');

      rmSync(command());
      symlinkSync('/usr/bin/true', command());
      const link = install(makeBundle('0.1.0'));
      expect(link.status).toBe(1);
      expect(readlinkSync(command())).toBe('/usr/bin/true');

      rmSync(command());
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      expect(install(makeBundle('0.1.1', 'next')).status).toBe(0);
      expect(readlinkSync(command())).toBe(join(base(), 'current', 'phone-app-checker'));
    });

    it('rejects an incomplete bundle', () => {
      const bundle = makeBundle('0.1.0');
      rmSync(join(bundle, 'app', 'bin', 'phone-app-checker.js'));
      const result = install(bundle);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('phone-app-checker.js');
      expect(existsSync(base())).toBe(false);
    });
  });

  describe('wrapper', () => {
    it('resolves the ~/.local/bin -> current -> <version> chain and forwards args, home and exit code', () => {
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      writeFileSync(log, '');

      const result = run(command(), ['check', 'file with spaces.csv', '--flag=a b'], {
        env: { NODE_OPTIONS: '--max-old-space-size=1', NODE_PATH: '/nonexistent' },
      });
      expect(result.status, result.stderr).toBe(0);
      const [call] = logged();
      expect(call?.argv).toEqual(['check', 'file with spaces.csv', '--flag=a b']);
      expect(call?.home).toBe(defaultHome);
      expect(call?.nodeOptions).toBeNull();
      expect(call?.nodePath).toBeNull();

      const preset = join(root, 'preset home');
      run(command(), ['x'], { env: { PHONE_APP_CHECKER_HOME: preset } });
      expect(logged()[1]?.home).toBe(preset);

      expect(run(command(), ['x'], { env: { STUB_EXIT: '7' } }).status).toBe(7);
    });

    it('works through a relative symlink', () => {
      makeBundle('0.1.0');
      const linkDir = join(root, 'links');
      mkdirSync(linkDir);
      symlinkSync('../bundle-0.1.0/phone-app-checker', join(linkDir, 'pac'));
      const result = run(join(linkDir, 'pac'), ['--version']);
      expect(result.status, result.stderr).toBe(0);
      expect(logged()[0]?.argv).toEqual(['--version']);
    });
  });

  describe('uninstall.sh', () => {
    function uninstall(args: string[] = [], input = '') {
      const installed = join(base(), 'current', 'uninstall.sh');
      const script = existsSync(installed) ? installed : join(makeBundle('0.0.0', 'standalone'), 'uninstall.sh');
      return run(script, args, { input });
    }

    function uninstallWith(env: Record<string, string>, args: string[] = []) {
      return run(join(base(), 'current', 'uninstall.sh'), args, { env });
    }

    function seedData(): string {
      const file = join(defaultHome, 'data', 'sessions', 'telegram', 'acct', 'session');
      mkdirSync(join(defaultHome, 'data', 'sessions', 'telegram', 'acct'), { recursive: true });
      writeFileSync(file, 'secret');
      writeFileSync(join(defaultHome, 'checker.config.json'), '{}');
      return file;
    }

    it('removes code, command link and PATH block but keeps data; other profile lines survive', () => {
      writeFileSync(zprofile(), 'export FOO=1\n');
      writeFileSync(join(home, '.bash_profile'), `alias a=b\n\n${BEGIN}\nexport PATH="$HOME/.local/bin:$PATH"\n${END}\nexport BAR=2\n`);
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      expect(count(readFileSync(zprofile(), 'utf8'), BEGIN)).toBe(1);
      const session = seedData();

      const result = uninstall();
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(base())).toBe(false);
      expect(existsSync(command())).toBe(false);
      expect(readFileSync(zprofile(), 'utf8')).toBe('export FOO=1\n');
      expect(readFileSync(join(home, '.bash_profile'), 'utf8')).toBe('alias a=b\nexport BAR=2\n');
      expect(readFileSync(session, 'utf8')).toBe('secret');
      expect(result.stdout).toContain('--purge-data');
    });

    it('preserves profile file mode', () => {
      writeFileSync(zprofile(), 'export FOO=1\n');
      chmodSync(zprofile(), 0o600);
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      expect(uninstall().status).toBe(0);
      expect(lstatSync(zprofile()).mode & 0o777).toBe(0o600);
    });

    it('removes a read-only installed tree', () => {
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      spawnSync('/bin/chmod', ['-R', 'a-w', join(base(), '0.1.0')]);
      expect(uninstall().status).toBe(0);
      expect(existsSync(base())).toBe(false);
    });

    it('--purge-data --yes removes the data home', () => {
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      seedData();
      const result = uninstall(['--purge-data', '--yes']);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(defaultHome)).toBe(false);
      expect(existsSync(base())).toBe(false);
    });

    it('--purge-data asks for DELETE; anything else keeps the data', () => {
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      const session = seedData();
      const refused = uninstall(['--purge-data'], 'no\n');
      expect(refused.status).toBe(0);
      expect(existsSync(session)).toBe(true);

      expect(install(makeBundle('0.1.0')).status).toBe(0);
      const confirmed = uninstall(['--purge-data'], 'DELETE\n');
      expect(confirmed.status, confirmed.stderr).toBe(0);
      expect(existsSync(defaultHome)).toBe(false);
    });

    it('refuses while a check holds the lock', () => {
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      lock();
      const result = uninstall();
      expect(result.status).toBe(1);
      expect(existsSync(join(base(), '0.1.0'))).toBe(true);
      expect(lstatSync(command()).isSymbolicLink()).toBe(true);
    });

    describe('run lock in a configured dataDir', () => {
      /** Seeds sessions, a database stand-in and a lock under <home>/store (dataDir './store'). */
      function seedStore(): { lockFile: string; db: string } {
        const store = join(defaultHome, 'store');
        mkdirSync(join(store, 'sessions', 'telegram', 'acct'), { recursive: true });
        writeFileSync(join(defaultHome, 'checker.config.json'), JSON.stringify({ dataDir: './store' }));
        const db = join(store, 'checker.db');
        writeFileSync(db, 'database');
        const lockFile = join(store, 'check.lock');
        writeFileSync(lockFile, JSON.stringify({ pid: 1 }));
        return { lockFile, db };
      }

      it("refuses a plain uninstall while a run holds <home>/store/check.lock (dataDir './store')", () => {
        expect(install(makeBundle('0.1.0')).status).toBe(0);
        const { lockFile } = seedStore();
        const result = uninstall();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(lockFile);
        expect(existsSync(join(base(), '0.1.0'))).toBe(true);
        expect(lstatSync(command()).isSymbolicLink()).toBe(true);
      });

      it("refuses --purge-data --yes while a run holds the lock in './store', deleting nothing", () => {
        expect(install(makeBundle('0.1.0')).status).toBe(0);
        const { lockFile, db } = seedStore();
        const result = uninstall(['--purge-data', '--yes']);
        expect(result.status).toBe(1);
        expect(readFileSync(db, 'utf8')).toBe('database');
        expect(existsSync(lockFile)).toBe(true);
        expect(existsSync(join(base(), '0.1.0'))).toBe(true);
      });

      it('proceeds once the lock is gone, and purge then removes the configured store too', () => {
        expect(install(makeBundle('0.1.0')).status).toBe(0);
        const { lockFile, db } = seedStore();
        rmSync(lockFile);
        const result = uninstall(['--purge-data', '--yes']);
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(db)).toBe(false);
        expect(existsSync(base())).toBe(false);
      });

      it('asks the CLI for the data directory: a lock in an absolute dataDir outside the home is honoured', () => {
        expect(install(makeBundle('0.1.0')).status).toBe(0);
        const elsewhere = join(root, 'elsewhere');
        mkdirSync(elsewhere);
        writeFileSync(join(elsewhere, 'check.lock'), JSON.stringify({ pid: 1 }));
        const refused = uninstallWith({ STUB_DATA_DIR: elsewhere });
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain(join(elsewhere, 'check.lock'));
        expect(existsSync(join(base(), '0.1.0'))).toBe(true);

        rmSync(join(elsewhere, 'check.lock'));
        expect(uninstallWith({ STUB_DATA_DIR: elsewhere }).status).toBe(0);
        expect(existsSync(base())).toBe(false);
      });

      it('the real CLI answers `data-dir` from checker.config.json (absolute dataDir outside the home)', () => {
        expect(install(realCliBundle('0.1.0')).status).toBe(0);
        const elsewhere = join(root, 'elsewhere');
        mkdirSync(elsewhere);
        writeFileSync(join(defaultHome, 'checker.config.json'), JSON.stringify({ dataDir: elsewhere }));
        writeFileSync(join(elsewhere, 'check.lock'), JSON.stringify({ pid: 1 }));

        const refused = uninstall();
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain(join(elsewhere, 'check.lock'));
        expect(existsSync(join(base(), '0.1.0'))).toBe(true);

        rmSync(join(elsewhere, 'check.lock'));
        expect(uninstall().status).toBe(0);
        expect(existsSync(base())).toBe(false);
      });

      it('ignores a CLI answer that is not an absolute path (broken or unknown command)', () => {
        expect(install(makeBundle('0.1.0')).status).toBe(0);
        expect(uninstallWith({ STUB_DATA_DIR: 'relative/path' }).status).toBe(0);
        expect(existsSync(base())).toBe(false);
      });
    });

    it('never deletes a foreign file or symlink at ~/.local/bin/phone-app-checker', () => {
      mkdirSync(join(home, '.local', 'bin'), { recursive: true });
      writeFileSync(command(), '#!/bin/sh\necho mine\n');
      expect(uninstall().status).toBe(0);
      expect(readFileSync(command(), 'utf8')).toContain('mine');

      rmSync(command());
      symlinkSync('/usr/bin/true', command());
      expect(uninstall().status).toBe(0);
      expect(readlinkSync(command())).toBe('/usr/bin/true');
    });

    it('leaves a profile alone when the closing marker is missing', () => {
      const text = `export A=1\n${BEGIN}\nexport PATH="x"\nexport KEEP=1\n`;
      writeFileSync(zprofile(), text);
      const result = uninstall();
      expect(result.status).toBe(0);
      expect(readFileSync(zprofile(), 'utf8')).toBe(text);
    });

    describe('--purge-data safety (sentinel files must survive)', () => {
      function sentinel(dir: string, name = 'sentinel.txt'): string {
        mkdirSync(dir, { recursive: true });
        const file = join(dir, name);
        writeFileSync(file, 'precious');
        return file;
      }

      function purge(target: string, extra: string[] = ['--yes']) {
        return run(join(base(), 'current', 'uninstall.sh'), ['--purge-data', ...extra], {
          env: { PHONE_APP_CHECKER_HOME: target },
          input: 'DELETE\n',
        });
      }

      function expectRefused(result: { status: number | null; stderr: string }, ...survivors: string[]) {
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain('unsafe data path');
        for (const file of survivors) expect(readFileSync(file, 'utf8')).toBe('precious');
        // nothing was uninstalled either: the check runs before any mutation
        expect(existsSync(join(base(), '0.1.0'))).toBe(true);
        expect(lstatSync(command()).isSymbolicLink()).toBe(true);
      }

      beforeEach(() => {
        expect(install(makeBundle('0.1.0')).status).toBe(0);
      });

      it.each([['$HOME//'], ['$HOME/'], ['$HOME'], ['$HOME/.'], ['$HOME/Library/..']])('refuses %s (the home directory)', (spelling) => {
        const kept = sentinel(home);
        mkdirSync(join(home, 'Library'), { recursive: true });
        const documents = sentinel(join(home, 'Documents'));
        expectRefused(purge(spelling.replace('$HOME', home)), kept, documents);
      });

      it('refuses the home directory even when it carries an app marker', () => {
        const kept = sentinel(home);
        writeFileSync(join(home, 'checker.config.json'), '{}');
        expectRefused(purge(`${home}//`), kept);
      });

      it('refuses $HOME/Documents (no app marker) even with --yes', () => {
        const kept = sentinel(join(home, 'Documents'));
        expectRefused(purge(join(home, 'Documents')), kept);
        expectRefused(purge(join(home, 'Documents'), ['--yes']), kept);
      });

      it('refuses an ancestor of HOME (a /Users-like parent), even with a marker', () => {
        // the real HOME of this test is root/home; make the ancestor look like our data directory
        writeFileSync(join(root, 'checker.config.json'), '{}');
        const kept = sentinel(root, 'sentinel.txt');
        expectRefused(purge(root), kept);
        expectRefused(purge(`${root}/`), kept);
        expectRefused(purge(join(home, '..')), kept);
        expectRefused(purge('/'), kept);
      });

      it('refuses a symlink that points at HOME, a legit data home, or an ancestor', () => {
        const kept = sentinel(home);
        const real = join(root, 'real-data', 'phone-app-checker');
        const session = sentinel(real);
        writeFileSync(join(real, 'checker.config.json'), '{}');
        symlinkSync(home, join(root, 'phone-app-checker')); // marker-looking name, but an alias of HOME
        symlinkSync(real, join(root, 'alias-data'));
        symlinkSync(root, join(root, 'alias-root'));

        expectRefused(purge(join(root, 'phone-app-checker')), kept);
        expectRefused(purge(join(root, 'phone-app-checker') + '/'), kept);
        expectRefused(purge(join(root, 'alias-data')), kept, session);
        expectRefused(purge(join(root, 'alias-root')), kept);
        expect(existsSync(real)).toBe(true);
      });

      it('refuses a directory that does not look like phone-app-checker data, even with --yes', () => {
        const foreign = sentinel(join(home, 'Projects', 'notes'));
        expectRefused(purge(join(home, 'Projects', 'notes')), foreign);
      });

      it('refuses a regular file', () => {
        const file = sentinel(join(root, 'f'));
        expectRefused(purge(file), file);
      });

      it('purges a dedicated phone-app-checker folder with its marker, deleting only that folder', () => {
        const keep = sentinel(join(home, 'Documents'));
        const dedicated = join(home, 'Documents', 'phone-app-checker');
        sentinel(dedicated);
        writeFileSync(join(dedicated, 'checker.config.json'), '{}');
        const sibling = sentinel(join(home, 'Documents', 'other'), 'sibling.txt');

        const result = purge(`${home}/Documents//phone-app-checker/`);
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(dedicated)).toBe(false);
        expect(readFileSync(keep, 'utf8')).toBe('precious');
        expect(readFileSync(sibling, 'utf8')).toBe('precious');
        expect(existsSync(base())).toBe(false);
      });

      it('also accepts data/checker.db as the marker', () => {
        const named = join(root, 'elsewhere', 'phone-app-checker');
        sentinel(join(named, 'data'), 'checker.db');
        const result = purge(named);
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(named)).toBe(false);
      });

      it('refuses a custom folder even with the marker (ownership of a custom folder cannot be proven)', () => {
        const custom = join(home, 'custom', 'my-data');
        const kept = sentinel(custom);
        writeFileSync(join(custom, 'checker.config.json'), '{}');
        const result = purge(custom);
        expectRefused(result, kept);
        expect(result.stderr).toContain('custom or shared folder');
        expect(existsSync(join(custom, 'checker.config.json'))).toBe(true);
      });

      it('refuses a folder named phone-app-checker that has no marker', () => {
        const named = join(root, 'elsewhere', 'phone-app-checker');
        const kept = sentinel(named);
        const result = purge(named);
        expectRefused(result, kept);
        expect(result.stderr).toContain('no phone-app-checker marker');
      });

      it('does not take a symlinked marker as proof', () => {
        const named = join(root, 'elsewhere', 'phone-app-checker');
        const kept = sentinel(named);
        symlinkSync(kept, join(named, 'checker.config.json'));
        expectRefused(purge(named), kept);
      });

      describe.each([
        'Documents',
        'Desktop',
        'Downloads',
        'Library',
        'Applications',
        'Movies',
        'Music',
        'Pictures',
        'Public',
        '.local',
        '.config',
        'Library/Application Support',
        '.local/bin',
        'Library/Mobile Documents',
        'Library/CloudStorage',
      ])('~/%s', (name) => {
        it('is refused even when it carries the app marker (what bootstrap would have left there)', () => {
          const folder = join(home, name);
          const kept = sentinel(folder);
          writeFileSync(join(folder, 'checker.config.json'), '{}');
          const result = purge(folder);
          expectRefused(result, kept);
          expect(result.stderr).toContain(`your own folder (${name})`);
          expect(existsSync(join(folder, 'checker.config.json'))).toBe(true);
          expectRefused(purge(`${folder}/`, ['--yes']), kept);
        });
      });

      describe.each([
        'Library/CloudStorage/Dropbox',
        'Library/CloudStorage/GoogleDrive-someone@example.com',
        'Library/CloudStorage/OneDrive-Personal',
        'Dropbox',
        'Dropbox (Personal)',
        'Google Drive',
        'OneDrive - Contoso',
        'Box',
        'iCloud Drive',
      ])('synced folder ~/%s', (name) => {
        it('is never deleted as a whole, even with the app marker and --yes', () => {
          const folder = join(home, name);
          const kept = sentinel(folder);
          writeFileSync(join(folder, 'checker.config.json'), '{}');
          const result = purge(folder);
          expectRefused(result, kept);
          expect(result.stderr).toContain(`synced cloud folder (${name})`);
          expect(existsSync(join(folder, 'checker.config.json'))).toBe(true);
          expectRefused(purge(`${folder}/`, ['--yes']), kept);
        });
      });

      it('refuses the external physical target of a symlinked CloudStorage provider child (parity with src/paths.ts), by link and by target', () => {
        const external = join(root, 'external-sync', 'phone-app-checker'); // a dedicated-looking name, so only the synced check can refuse it
        const kept = sentinel(external);
        writeFileSync(join(external, 'checker.config.json'), '{}');
        mkdirSync(join(home, 'Library', 'CloudStorage'), { recursive: true });
        symlinkSync(external, join(home, 'Library', 'CloudStorage', 'Dropbox'));
        const byTarget = purge(external);
        expectRefused(byTarget, kept);
        expect(byTarget.stderr).toContain('synced cloud folder (Library/CloudStorage/Dropbox)');
        expectRefused(purge(`${external}/`, ['--yes']), kept);
        expectRefused(purge(join(home, 'Library', 'CloudStorage', 'Dropbox')), kept); // the link itself
        expect(existsSync(join(external, 'checker.config.json'))).toBe(true);
      });

      it('refuses a synced folder reached through a symlinked ancestor', () => {
        const folder = join(home, 'Dropbox');
        const kept = sentinel(folder);
        writeFileSync(join(folder, 'checker.config.json'), '{}');
        symlinkSync(home, join(root, 'home-alias'));
        expectRefused(purge(join(root, 'home-alias', 'Dropbox')), kept);
      });

      it('refuses ~/Documents spelled in another letter case, symlinked or through ..', () => {
        const documents = join(home, 'Documents');
        const kept = sentinel(documents);
        writeFileSync(join(documents, 'checker.config.json'), '{}');
        if (existsSync(join(home, 'DOCUMENTS'))) expectRefused(purge(join(home, 'documents')), kept); // case-insensitive volume
        symlinkSync(home, join(root, 'home-alias'));
        expectRefused(purge(join(root, 'home-alias', 'Documents')), kept); // symlinked ancestor
        expectRefused(purge(`${home}/Library/../Documents`), kept);
      });

      it('refuses a folder that contains or lies inside the installation tree, and the lifecycle directory', () => {
        const inside = join(base(), 'phone-app-checker');
        mkdirSync(inside, { recursive: true });
        writeFileSync(join(inside, 'checker.config.json'), '{}');
        expect(purge(inside).status).toBe(1);
        expect(existsSync(inside)).toBe(true);
        expect(existsSync(join(base(), '0.1.0'))).toBe(true);
      });

      it('treats a missing data directory as nothing to delete and still uninstalls', () => {
        const result = purge(join(home, 'never-created', 'phone-app-checker'));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('No data to delete');
        expect(existsSync(base())).toBe(false);
      });

      it('asks for DELETE on the resolved path, and refuses before asking when unsafe', () => {
        const kept = sentinel(join(home, 'Documents'));
        const asked = run(join(base(), 'current', 'uninstall.sh'), ['--purge-data'], {
          env: { PHONE_APP_CHECKER_HOME: join(home, 'Documents') },
          input: 'DELETE\n',
        });
        expectRefused(asked, kept);
        expect(asked.stdout).not.toContain('DELETE');
      });
    });

    describe('profile editing', () => {
      it('keeps a symlinked profile a symlink and keeps the target mode and other lines', () => {
        const dotfiles = join(home, 'dotfiles');
        mkdirSync(dotfiles);
        const real = join(dotfiles, 'zprofile');
        writeFileSync(real, 'export FOO=1\n');
        chmodSync(real, 0o640);
        symlinkSync(real, zprofile());

        expect(install(makeBundle('0.1.0')).status).toBe(0);
        expect(lstatSync(zprofile()).isSymbolicLink()).toBe(true);
        expect(count(readFileSync(real, 'utf8'), BEGIN)).toBe(1);

        const tmpDir = join(root, 'tmp');
        mkdirSync(tmpDir);
        const result = run(join(base(), 'current', 'uninstall.sh'), [], { env: { TMPDIR: tmpDir } });
        expect(result.status, result.stderr).toBe(0);
        expect(lstatSync(zprofile()).isSymbolicLink()).toBe(true);
        expect(readlinkSync(zprofile())).toBe(real);
        expect(lstatSync(real).mode & 0o777).toBe(0o640);
        expect(readFileSync(real, 'utf8')).toBe('export FOO=1\n');
        expect(readdirSync(tmpDir)).toEqual([]); // private temp file removed
      });

      it('leaves a symlinked profile alone when its target is not writable', () => {
        const real = join(root, 'ro-profile');
        writeFileSync(real, `export A=1\n\n${BEGIN}\nexport PATH="x"\n${END}\n`);
        chmodSync(real, 0o444);
        symlinkSync(real, zprofile());
        const result = uninstall();
        expect(result.status, result.stderr).toBe(0);
        expect(lstatSync(zprofile()).isSymbolicLink()).toBe(true);
        expect(count(readFileSync(real, 'utf8'), BEGIN)).toBe(1);
      });

      it.each([
        ['a trailing space on the closing marker', `${END} `],
        ['a comment on the closing marker', `${END} # added by me`],
        ['a tab on the closing marker', `${END}\t`],
      ])('leaves the whole profile untouched with %s, and says how to fix it by hand', (_name, closing) => {
        const text = `export A=1\n\n${BEGIN}\nexport PATH="x"\n${closing}\nexport KEEP=1\nexport ALSO=2\n`;
        writeFileSync(zprofile(), text);
        const result = uninstall();
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(zprofile(), 'utf8')).toBe(text);
        expect(result.stderr).toContain(zprofile());
        expect(result.stderr).toContain(BEGIN);
        expect(result.stderr).toContain(END);
        expect(result.stdout).not.toContain('Removed PATH block');
      });

      it.each([
        ['an opening marker with trailing text', `export A=1\n${BEGIN} # mine\nexport PATH="x"\n${END}\nexport KEEP=1\n`],
        ['CRLF line endings', `export A=1\r\n${BEGIN}\r\nexport PATH="x"\r\n${END}\r\nexport KEEP=1\r\n`],
        ['two opening markers before one closing marker', `${BEGIN}\nexport A=1\n${BEGIN}\nexport PATH="x"\n${END}\nexport KEEP=1\n`],
        ['a closing marker before any opening marker', `${END}\nexport A=1\n${BEGIN}\nexport PATH="x"\n${END}\nexport KEEP=1\n`],
        ['a balanced block followed by an unterminated one', `${BEGIN}\nx\n${END}\nexport KEEP=1\n${BEGIN}\nexport PATH="y"\nexport LATER=1\n`],
        ['an extra closing marker after a balanced block', `${BEGIN}\nx\n${END}\nexport KEEP=1\n${END}\nexport LATER=1\n`],
      ])('leaves the whole profile untouched with %s', (_name, text) => {
        writeFileSync(zprofile(), text);
        const result = uninstall();
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(zprofile(), 'utf8')).toBe(text);
        expect(result.stderr).toContain('left untouched');
      });

      it('removes every exact balanced block (duplicates) and keeps all other lines', () => {
        writeFileSync(
          zprofile(),
          `export A=1\n\n${BEGIN}\nexport PATH="x"\n${END}\nexport B=2\n\n${BEGIN}\nexport PATH="y"\n${END}\nexport C=3\n`,
        );
        const result = uninstall();
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(zprofile(), 'utf8')).toBe('export A=1\nexport B=2\nexport C=3\n');
      });

      it('a bad ~/.zprofile does not stop ~/.bash_profile from being cleaned', () => {
        const bad = `${BEGIN}\nexport PATH="x"\n${END} \nexport KEEP=1\n`;
        writeFileSync(zprofile(), bad);
        writeFileSync(join(home, '.bash_profile'), `export A=1\n${BEGIN}\nexport PATH="x"\n${END}\nexport B=2\n`);
        expect(uninstall().status).toBe(0);
        expect(readFileSync(zprofile(), 'utf8')).toBe(bad);
        expect(readFileSync(join(home, '.bash_profile'), 'utf8')).toBe('export A=1\nexport B=2\n');
      });
    });

    it('rejects unknown flags with usage and exit 2, deleting nothing', () => {
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      const result = uninstall(['--nuke']);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Usage');
      expect(existsSync(join(base(), '0.1.0'))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Lifecycle exclusion, interrupted activation, atomic profile rewrites, destructive-path ownership.
// ---------------------------------------------------------------------------------------------

const lifecycle = (): string => lifecycleDir(home);
const barrierFile = (): string => join(lifecycle(), LIFECYCLE_BARRIER);
const sharedDir = (): string => join(lifecycle(), LIFECYCLE_SHARED);

const sleepers: ChildProcess[] = [];
afterEach(() => {
  for (const child of sleepers.splice(0)) child.kill('SIGKILL');
});

function livePid(): number {
  const child = spawn('sleep', ['120'], { stdio: 'ignore' });
  sleepers.push(child);
  if (child.pid === undefined) throw new Error('spawn failed');
  return child.pid;
}

function deadPid(): number {
  const result = spawnSync('/usr/bin/true');
  if (result.pid === undefined) throw new Error('spawn failed');
  return result.pid;
}

function writeBarrier(pid: number): void {
  mkdirSync(lifecycle(), { recursive: true });
  writeFileSync(barrierFile(), `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`);
}

function register(pid: number): string {
  mkdirSync(sharedDir(), { recursive: true });
  const file = join(sharedDir(), `${pid}.0123456789abcdef`);
  writeFileSync(file, `${JSON.stringify({ pid })}\n`);
  return file;
}

/** A script that keeps running while the test pokes at it. */
class Running {
  readonly child: ChildProcessWithoutNullStreams;
  stdout = '';
  stderr = '';
  private readonly closed = Promise.withResolvers<{ status: number | null; signal: NodeJS.Signals | null }>();

  constructor(script: string, args: string[], env: Record<string, string> = {}) {
    this.child = spawn('/bin/bash', [script, ...args], { env: baseEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8').on('data', (chunk: string) => (this.stdout += chunk));
    this.child.stderr.setEncoding('utf8').on('data', (chunk: string) => (this.stderr += chunk));
    this.child.on('close', (status, signal) => this.closed.resolve({ status, signal }));
  }

  /** Poll until `condition` holds; the timer only bounds a hung child. */
  async until(condition: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\nstdout: ${this.stdout}\nstderr: ${this.stderr}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  done(): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
    return this.closed.promise;
  }
}

const COMMANDS: [string, string[]][] = [
  ['check', ['check', 'CSV', '--out', 'OUT']],
  ['login', ['login', 'telegram']],
  ['report', ['report', 'CSV', '--out', 'OUT']],
  ['accounts', ['accounts']],
  ['account-reset', ['account-reset', 'telegram', 'default']],
  ['doctor', ['doctor']],
];

/** Run every CLI entry point in-process against the lifecycle directory the scripts use; each must be refused. */
async function expectAllCommandsRefused(pattern: RegExp): Promise<void> {
  const csv = join(root, 'numbers.csv');
  writeFileSync(csv, 'phone\n0901234567\n');
  const outDir = join(root, 'out');
  mkdirSync(outDir, { recursive: true });
  const external = join(root, 'external-data');
  const configFile = join(root, 'explicit.config.json');
  writeFileSync(configFile, JSON.stringify({ dataDir: external }));
  const otherHome = join(root, 'other-home', 'phone-app-checker');

  const setups: [string, string[], NodeJS.ProcessEnv][] = [
    ['default home', [], { PHONE_APP_CHECKER_HOME: defaultHome }],
    ['explicit --config, external dataDir', ['--config', configFile], {}],
    ['another PHONE_APP_CHECKER_HOME', [], { PHONE_APP_CHECKER_HOME: otherHome }],
  ];
  const before = snapshot(root);
  for (const [label, prefix, env] of setups) {
    for (const [name, template] of COMMANDS) {
      const argv = template.map((a) => (a === 'CSV' ? csv : a === 'OUT' ? join(outDir, 'report.csv') : a));
      const cli = createProgram({
        lifecycleDir: lifecycle(),
        env,
        log: () => {},
        print: () => {},
        loadAdapter: async () => {
          throw new Error('adapter must not load during maintenance');
        },
      });
      await expect(cli.parseAsync([...prefix, ...argv], { from: 'user' }), `${name} (${label})`).rejects.toThrow(pattern);
    }
  }
  expect(existsSync(external)).toBe(false);
  expect(existsSync(otherHome)).toBe(false);
  expect(readdirSync(outDir)).toEqual([]);
  expect(snapshot(root).filter((entry) => !entry.includes('numbers.csv') && !entry.includes('explicit.config') && !entry.startsWith('out'))).toEqual(
    before.filter((entry) => !entry.includes('numbers.csv') && !entry.includes('explicit.config') && !entry.startsWith('out')),
  );
}

/** Sorted list of every path below `dir` (relative), for "nothing was created or removed" assertions. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      out.push(rel);
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

describe.skipIf(process.platform !== 'darwin')('lifecycle exclusion: maintenance holds, commands share', () => {
  function seedData(): string {
    const file = join(defaultHome, 'data', 'sessions', 'telegram', 'acct', 'session');
    mkdirSync(join(defaultHome, 'data', 'sessions', 'telegram', 'acct'), { recursive: true });
    writeFileSync(file, 'secret');
    writeFileSync(join(defaultHome, 'checker.config.json'), '{}');
    return file;
  }

  it('uninstall --purge-data holds the exclusion across the DELETE prompt: every command is refused, nothing is opened, then the purge completes', async () => {
    expect(install(realCliBundle('0.1.0')).status).toBe(0);
    const session = seedData();
    const homeBefore = snapshot(defaultHome);

    const purge = new Running(join(base(), 'current', 'uninstall.sh'), ['--purge-data']);
    await purge.until(() => purge.stdout.includes('DELETE'), 'the DELETE prompt');
    expect(JSON.parse(readFileSync(barrierFile(), 'utf8')).pid).toBe(purge.child.pid);

    await expectAllCommandsRefused(/uninstall of phone-app-checker is in progress/);
    // the real installed launcher is refused as well (a separate process, HOME from the environment)
    for (const argv of [['accounts'], ['check', join(root, 'numbers.csv'), '--out', join(root, 'out', 'r.csv')], ['doctor']]) {
      const refused = run(command(), argv);
      expect(refused.status, refused.stdout).toBe(1);
      expect(refused.stderr).toContain('is in progress');
    }
    expect(snapshot(defaultHome)).toEqual(homeBefore); // nothing created under the home being purged
    expect(readFileSync(session, 'utf8')).toBe('secret');
    expect(existsSync(join(base(), '0.1.0'))).toBe(true);

    purge.child.stdin.write('DELETE\n');
    const finished = await purge.done();
    expect(finished.status, purge.stderr).toBe(0);
    expect(existsSync(defaultHome)).toBe(false);
    expect(existsSync(base())).toBe(false);
    expect(existsSync(lifecycle())).toBe(false); // the barrier is released and the empty directories removed
  }, 90_000);

  it('reinstall holds the exclusion while the new copy is being copied: commands are refused until it finishes', async () => {
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    writeFileSync(join(base(), '0.1.0', 'marker'), 'old');
    const ctrl = join(root, 'ctrl');
    mkdirSync(ctrl);
    executable(
      join(stubDir, 'cp'),
      `case "$*" in *.incoming.*) : > "${ctrl}/copying"; while [ ! -e "${ctrl}/continue" ]; do sleep 0.05; done ;; esac\nexec /bin/cp "$@"`,
    );

    const reinstall = new Running(join(makeBundle('0.1.0', 'again'), 'install.sh'), []);
    await reinstall.until(() => existsSync(join(ctrl, 'copying')), 'the copy to start');
    expect(JSON.parse(readFileSync(barrierFile(), 'utf8')).pid).toBe(reinstall.child.pid);
    await expectAllCommandsRefused(/install or uninstall of phone-app-checker is in progress/);
    expect(readFileSync(join(base(), '0.1.0', 'marker'), 'utf8')).toBe('old'); // still the installed copy

    writeFileSync(join(ctrl, 'continue'), '');
    const finished = await reinstall.done();
    expect(finished.status, reinstall.stderr).toBe(0);
    expect(existsSync(barrierFile())).toBe(false);
    expect(existsSync(join(base(), '0.1.0', 'marker'))).toBe(false); // replaced
  }, 90_000);

  describe.each([
    ['install.sh', () => join(makeBundle('0.1.0', 'fresh'), 'install.sh')],
    ['uninstall.sh', () => join(makeBundle('0.0.0', 'standalone'), 'uninstall.sh')],
  ])('%s', (_script, scriptPath) => {
    const go = (env: Record<string, string> = {}) => run(scriptPath(), [], { env: { PHONE_APP_CHECKER_LIFECYCLE_WAIT: '0', ...env } });

    it('refuses while a command is registered, names its pid and registration file, and leaves the barrier released and everything in place', () => {
      const pid = livePid();
      const registration = register(pid);
      mkdirSync(join(home, 'Applications', 'phone-app-checker', 'keep'), { recursive: true });
      const before = snapshot(home).filter((entry) => !entry.startsWith('Library/Application Support/phone-app-checker-lifecycle'));
      const result = go();
      expect(result.status, result.stdout).toBe(1);
      expect(result.stderr).toContain(`pid ${pid}`);
      expect(result.stderr).toContain('phone-app-checker command is running');
      expect(result.stderr).toContain(`If nothing is running, delete ${registration}`);
      expect(existsSync(barrierFile())).toBe(false);
      expect(snapshot(home).filter((entry) => !entry.startsWith('Library/Application Support/phone-app-checker-lifecycle'))).toEqual(before);
    });

    it('ignores (and removes) a registration whose process died', () => {
      const dead = register(deadPid());
      expect(go().status).toBe(0);
      expect(existsSync(dead)).toBe(false);
    });

    it('fails closed on an abandoned barrier: repair guidance, barrier untouched; works once it is deleted', () => {
      const dead = deadPid();
      writeBarrier(dead);
      const content = readFileSync(barrierFile(), 'utf8');
      const result = go();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('was interrupted');
      expect(result.stderr).toContain(barrierFile());
      expect(result.stderr).toContain(`pid ${dead}`);
      expect(readFileSync(barrierFile(), 'utf8')).toBe(content);
      expect(existsSync(base())).toBe(false);

      rmSync(barrierFile());
      expect(go().status).toBe(0);
    });

    it('refuses while another install/uninstall is running (live barrier), names the file and how to clear it, and does not touch it', () => {
      const pid = livePid();
      writeBarrier(pid);
      const result = go();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`pid ${pid}`);
      expect(result.stderr).toContain('running');
      expect(result.stderr).toContain(`If nothing is running, delete ${barrierFile()}`);
      expect(JSON.parse(readFileSync(barrierFile(), 'utf8')).pid).toBe(pid);
    });

    it('counts a pid it may not signal (EPERM: launchd, pid 1) as alive, exactly like the Node side: fail closed with the repair path', () => {
      writeBarrier(1);
      const result = go();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('is running');
      expect(result.stderr).not.toContain('is gone');
      expect(result.stderr).toContain(`If nothing is running, delete ${barrierFile()}`);
      expect(JSON.parse(readFileSync(barrierFile(), 'utf8')).pid).toBe(1);

      const shared = register(1);
      rmSync(barrierFile());
      const registered = go();
      expect(registered.status).toBe(1);
      expect(registered.stderr).toContain('phone-app-checker command is running');
      expect(registered.stderr).toContain(`If nothing is running, delete ${shared}`);
      expect(existsSync(shared)).toBe(true); // never removed on a doubtful pid
    });
  });

  it('a command that registered and then finishes while maintenance waits lets it proceed', () => {
    // An orphan (reparented to launchd, so it is reaped at exit and kill -0 stops succeeding at once).
    const started = spawnSync('/bin/sh', ['-c', 'sleep 1 >/dev/null 2>&1 & echo $!'], { encoding: 'utf8' });
    const pid = Number(started.stdout.trim());
    expect(Number.isInteger(pid) && pid > 0).toBe(true);
    const file = register(pid);
    const result = run(join(makeBundle('0.1.0', 'waits'), 'install.sh'), [], { env: { PHONE_APP_CHECKER_LIFECYCLE_WAIT: '10' } });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(file)).toBe(false);
  }, 30_000);

  it('the shared helper block is identical in install.sh and uninstall.sh', () => {
    const block = (file: string): string => {
      const text = readFileSync(join(RELEASE_DIR, file), 'utf8');
      const start = text.indexOf('# >>> shared helpers');
      const end = text.indexOf('# <<< shared helpers <<<');
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      return text.slice(start, end);
    };
    expect(block('install.sh')).toBe(block('uninstall.sh'));
    expect(block('install.sh')).toContain('lifecycle_acquire');
  });

  it('the shell list of the user\'s own folders equals SHARED_USER_DIRS in src/paths.ts', () => {
    const text = readFileSync(join(RELEASE_DIR, 'uninstall.sh'), 'utf8');
    const line = /for name in (.*); do\n\s+if \[ -d "\$HOME\/\$name" \]/.exec(text)?.[1];
    expect(line).toBeDefined();
    const names = [...(line ?? '').matchAll(/"([^"]+)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
    expect(names).toEqual([...SHARED_USER_DIRS]);
  });
});

describe.skipIf(process.platform !== 'darwin')('interrupted and failed activation keeps a recoverable installation', () => {
  /** `mv` that can be told to kill the running script (SIGKILL, like a power cut) or fail at a named step. */
  function stubMv(): void {
    executable(
      join(stubDir, 'mv'),
      [
        'if [ -n "${STUB_MV_KILL:-}" ]; then case "$*" in *"$STUB_MV_KILL"*) kill -9 "$PPID"; exit 137 ;; esac; fi',
        'if [ -n "${STUB_MV_FAIL:-}" ]; then case "$*" in *"$STUB_MV_FAIL"*) echo "mv: injected failure" >&2; exit 1 ;; esac; fi',
        'exec /bin/mv "$@"',
      ].join('\n'),
    );
  }

  function installedWithMarker(version = '0.1.0'): void {
    expect(install(makeBundle(version)).status).toBe(0);
    writeFileSync(join(base(), version, 'marker'), 'old');
  }

  const replaced = (): string[] => readdirSync(base()).filter((name) => name.startsWith('.replaced.'));
  const incoming = (): string[] => readdirSync(base()).filter((name) => name.startsWith('.incoming.'));

  /** Reinstall of 0.1.0 killed (SIGKILL) at the moment the new copy is moved into place. */
  function killedMidActivation(): { newBundle: string } {
    installedWithMarker();
    stubMv();
    const newBundle = makeBundle('0.1.0', 'new-copy');
    writeFileSync(join(newBundle, 'new-file'), 'new');
    const result = run(join(newBundle, 'install.sh'), [], { env: { STUB_MV_KILL: '.incoming.' } });
    expect(result.status).toBeNull(); // killed, nothing ran after the kill
    return { newBundle };
  }

  it('SIGKILL between "old copy moved aside" and "new copy moved in": the old copy is still on disk, recoverable', () => {
    killedMidActivation();
    expect(existsSync(join(base(), '0.1.0'))).toBe(false);
    const [kept] = replaced();
    expect(replaced()).toHaveLength(1);
    expect(readFileSync(join(base(), kept ?? '', 'marker'), 'utf8')).toBe('old');
    expect(incoming()).toHaveLength(1); // the prepared new copy is there too
    expect(existsSync(barrierFile())).toBe(true); // the killed script could not release it
  });

  it('the next install fails closed on the abandoned barrier until it is repaired, then restores and completes', () => {
    const { newBundle } = killedMidActivation();
    const refused = install(newBundle);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('was interrupted');
    expect(existsSync(join(base(), '0.1.0'))).toBe(false);

    rmSync(barrierFile());
    const result = install(newBundle);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(base(), '0.1.0', 'new-file'), 'utf8')).toBe('new');
    expect(replaced()).toEqual([]);
    expect(incoming()).toEqual([]);
    expect(readlinkSync(join(base(), 'current'))).toBe('0.1.0');
    expect(run(command(), ['--version']).status).toBe(0);
  });

  it('install.sh run from the retained copy puts the previous installation back (rollback path in the guide)', () => {
    killedMidActivation();
    const [kept] = replaced();
    rmSync(barrierFile());
    const result = run(join(base(), kept ?? '', 'install.sh'));
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(base(), '0.1.0', 'marker'), 'utf8')).toBe('old');
    expect(existsSync(join(base(), '0.1.0', 'new-file'))).toBe(false);
    expect(replaced()).toEqual([]);
    expect(run(command(), ['--version']).status).toBe(0);
  });

  it('a failed move of the new copy rolls the old one back in place (no SIGKILL needed)', () => {
    installedWithMarker();
    stubMv();
    const result = run(join(makeBundle('0.1.0', 'again'), 'install.sh'), [], { env: { STUB_MV_FAIL: '.incoming.' } });
    expect(result.status).not.toBe(0);
    expect(readFileSync(join(base(), '0.1.0', 'marker'), 'utf8')).toBe('old');
    expect(replaced()).toEqual([]);
    expect(incoming()).toEqual([]);
    expect(existsSync(barrierFile())).toBe(false);
    expect(readlinkSync(join(base(), 'current'))).toBe('0.1.0');
  });

  it('a new copy that fails its self-check is removed and the old copy is restored (same version)', () => {
    installedWithMarker();
    const broken = makeBundle('0.1.0', 'broken');
    writeFileSync(join(broken, 'app', 'bin', 'phone-app-checker.js'), 'process.exit(3);');
    const result = install(broken);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--version');
    expect(readFileSync(join(base(), '0.1.0', 'marker'), 'utf8')).toBe('old');
    expect(replaced()).toEqual([]);
    expect(existsSync(barrierFile())).toBe(false);
    expect(run(command(), ['--version']).status).toBe(0);
  });

  it('a newer version that fails its self-check is removed and `current` keeps pointing at the working one', () => {
    installedWithMarker();
    const broken = makeBundle('0.2.0', 'broken');
    writeFileSync(join(broken, 'app', 'bin', 'phone-app-checker.js'), 'process.exit(3);');
    expect(install(broken).status).toBe(1);
    expect(readlinkSync(join(base(), 'current'))).toBe('0.1.0');
    expect(existsSync(join(base(), '0.2.0'))).toBe(false);
    expect(readFileSync(join(base(), '0.1.0', 'marker'), 'utf8')).toBe('old');
    expect(run(command(), ['--version']).status).toBe(0);
  });

  it('a failed first install leaves nothing behind (no dangling command link, no current)', () => {
    const broken = makeBundle('0.1.0', 'broken');
    writeFileSync(join(broken, 'app', 'bin', 'phone-app-checker.js'), 'process.exit(3);');
    expect(install(broken).status).toBe(1);
    expect(existsSync(join(base(), '0.1.0'))).toBe(false);
    expect(lstatSync(command(), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(join(base(), 'current'), { throwIfNoEntry: false })).toBeUndefined();
  });

  describe('a failed or interrupted reinstall keeps the working `current` link', () => {
    /** xattr that keeps reporting the quarantine flag (STUB_XATTR_STUCK) and/or sends SIGINT to install.sh (STUB_XATTR_INT) while clearing it. */
    function stubXattr(): void {
      executable(
        join(stubDir, 'xattr'),
        [
          'case "$1" in',
          '  -dr)',
          '    if [ -n "${STUB_XATTR_INT:-}" ]; then kill -INT "$PPID"; sleep 0.5; fi',
          '    if [ -n "${STUB_XATTR_STUCK:-}" ]; then exit 0; fi ;;',
          '  -lr)',
          '    if [ -n "${STUB_XATTR_STUCK:-}" ]; then echo "$2: com.apple.quarantine: 0081;5f5e1000;Safari;"; exit 0; fi ;;',
          'esac',
          'exec /usr/bin/xattr "$@"',
        ].join('\n'),
      );
    }

    function expectWorking(version: string): void {
      expect(readlinkSync(join(base(), 'current'))).toBe(version);
      expect(existsSync(join(base(), 'current', 'phone-app-checker'))).toBe(true); // the link resolves
      const result = run(command(), ['--version']);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(barrierFile())).toBe(false);
    }

    it.each([
      ['quarantine cannot be cleared (die at that step)', { STUB_XATTR_STUCK: '1' }, 1],
      ['Ctrl-C while xattr runs', { STUB_XATTR_INT: '1' }, 130],
    ])('same-version reinstall: %s', (_name, env, status) => {
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      writeFileSync(join(base(), '0.1.0', 'marker'), 'old');
      stubXattr();
      const result = run(join(makeBundle('0.1.0', 'again'), 'install.sh'), [], { env });
      expect(result.status, result.stderr).toBe(status);
      expectWorking('0.1.0');
      expect(readFileSync(join(base(), '0.1.0', 'marker'), 'utf8')).toBe('old'); // the previous copy is back
      expect(readdirSync(base()).filter((name) => name.startsWith('.replaced.') || name.startsWith('.incoming.'))).toEqual([]);
    });

    it.each([
      ['quarantine cannot be cleared', { STUB_XATTR_STUCK: '1' }, 1],
      ['Ctrl-C while xattr runs', { STUB_XATTR_INT: '1' }, 130],
    ])('update to another version: %s; `current` keeps pointing at the old version', (_name, env, status) => {
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      stubXattr();
      const result = run(join(makeBundle('0.2.0'), 'install.sh'), [], { env });
      expect(result.status, result.stderr).toBe(status);
      expectWorking('0.1.0');
      expect(existsSync(join(base(), '0.2.0'))).toBe(false);
    });

    it('a failed FIRST install still leaves no `current` and no dangling command link', () => {
      stubXattr();
      expect(run(join(makeBundle('0.1.0'), 'install.sh'), [], { env: { STUB_XATTR_STUCK: '1' } }).status).toBe(1);
      expect(lstatSync(join(base(), 'current'), { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(command(), { throwIfNoEntry: false })).toBeUndefined();
      expect(existsSync(join(base(), '0.1.0'))).toBe(false);
    });
  });

  it('the command and current links are switched by rename: no unlink-then-create window', () => {
    const text = readFileSync(join(RELEASE_DIR, 'install.sh'), 'utf8');
    expect(text).not.toMatch(/ln -sfn/);
    expect(text).toContain('/bin/mv -fh');
  });
});

describe.skipIf(process.platform !== 'darwin')('shell profile rewrites are atomic', () => {
  function stubMv(): void {
    executable(
      join(stubDir, 'mv'),
      [
        'if [ -n "${STUB_MV_KILL:-}" ]; then case "$*" in *"$STUB_MV_KILL"*) kill -9 "$PPID"; exit 137 ;; esac; fi',
        'if [ -n "${STUB_MV_FAIL:-}" ]; then case "$*" in *"$STUB_MV_FAIL"*) echo "mv: injected failure" >&2; exit 1 ;; esac; fi',
        'exec /bin/mv "$@"',
      ].join('\n'),
    );
  }

  const ORIGINAL = 'export FOO=1\nalias ll="ls -l"\n';
  const tempLeftovers = (dir: string): string[] => readdirSync(dir).filter((name) => name.startsWith('.phone-app-checker-profile.'));

  it('install: SIGKILL while the new profile is renamed into place leaves the original complete and unchanged', () => {
    writeFileSync(zprofile(), ORIGINAL);
    chmodSync(zprofile(), 0o640);
    stubMv();
    const result = install(makeBundle('0.1.0'), { STUB_MV_KILL: 'phone-app-checker-profile' });
    expect(result.status).toBeNull();
    expect(readFileSync(zprofile(), 'utf8')).toBe(ORIGINAL);
    expect(lstatSync(zprofile()).mode & 0o777).toBe(0o640);
  });

  it('install: a failing rename is reported, the original is untouched, no temp file remains, the install still succeeds', () => {
    writeFileSync(zprofile(), ORIGINAL);
    stubMv();
    const result = install(makeBundle('0.1.0'), { STUB_MV_FAIL: 'phone-app-checker-profile' });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(zprofile(), 'utf8')).toBe(ORIGINAL);
    expect(result.stdout).toContain('Could not update');
    expect(result.stdout).toContain('export PATH=');
    expect(tempLeftovers(home)).toEqual([]);
  });

  it('uninstall: SIGKILL while the stripped profile is renamed into place leaves the original (with its block) unchanged', () => {
    writeFileSync(zprofile(), ORIGINAL);
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    const withBlock = readFileSync(zprofile(), 'utf8');
    expect(withBlock).toContain(BEGIN);
    chmodSync(zprofile(), 0o640);
    stubMv();
    const result = run(join(base(), 'current', 'uninstall.sh'), [], { env: { STUB_MV_KILL: 'phone-app-checker-profile' } });
    expect(result.status).toBeNull();
    expect(readFileSync(zprofile(), 'utf8')).toBe(withBlock);
    expect(lstatSync(zprofile()).mode & 0o777).toBe(0o640);
  });

  it('uninstall: a failing rename leaves the original and says so; the rest of the uninstall still happens', () => {
    writeFileSync(zprofile(), ORIGINAL);
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    const withBlock = readFileSync(zprofile(), 'utf8');
    stubMv();
    const result = run(join(base(), 'current', 'uninstall.sh'), [], { env: { STUB_MV_FAIL: 'phone-app-checker-profile' } });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(zprofile(), 'utf8')).toBe(withBlock);
    expect(result.stderr).toContain('not writable');
    expect(tempLeftovers(home)).toEqual([]);
    expect(existsSync(base())).toBe(false);
  });

  it('install adds the block to a symlinked profile: the link stays, the real file keeps mode and content', () => {
    const dotfiles = join(home, 'dotfiles');
    mkdirSync(dotfiles);
    const real = join(dotfiles, 'zprofile');
    writeFileSync(real, ORIGINAL);
    chmodSync(real, 0o640);
    symlinkSync(real, zprofile());
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    expect(lstatSync(zprofile()).isSymbolicLink()).toBe(true);
    expect(readlinkSync(zprofile())).toBe(real);
    expect(lstatSync(real).mode & 0o777).toBe(0o640);
    expect(readFileSync(real, 'utf8')).toBe(`${ORIGINAL}\n${BEGIN}\nexport PATH="$HOME/.local/bin:$PATH"\n${END}\n`);
    expect(tempLeftovers(dotfiles)).toEqual([]);
    expect(tempLeftovers(home)).toEqual([]);
  });

  it('install: a profile whose real directory is not writable is left alone with a manual instruction', () => {
    const dotfiles = join(home, 'dotfiles');
    mkdirSync(dotfiles);
    const real = join(dotfiles, 'zprofile');
    writeFileSync(real, ORIGINAL);
    symlinkSync(real, zprofile());
    chmodSync(dotfiles, 0o555);
    try {
      const result = install(makeBundle('0.1.0'));
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(real, 'utf8')).toBe(ORIGINAL);
      expect(result.stdout).toContain('Could not update');
    } finally {
      chmodSync(dotfiles, 0o755);
    }
  });

  it('install keeps the original ending (no newline at EOF) and separates the block by one blank line', () => {
    writeFileSync(zprofile(), 'export FOO=1');
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    expect(readFileSync(zprofile(), 'utf8')).toBe(`export FOO=1\n\n${BEGIN}\nexport PATH="$HOME/.local/bin:$PATH"\n${END}\n`);
  });
});

describe.skipIf(process.platform !== 'darwin')('data and home must stay outside the installation tree; purge reports what it keeps', () => {
  function seedData(): void {
    mkdirSync(join(defaultHome, 'data', 'sessions', 'telegram', 'acct'), { recursive: true });
    writeFileSync(join(defaultHome, 'data', 'sessions', 'telegram', 'acct', 'session'), 'secret');
    writeFileSync(join(defaultHome, 'checker.config.json'), '{}');
  }

  it('install refuses a data home inside the installation tree before writing anything', () => {
    const result = install(makeBundle('0.1.0'), { PHONE_APP_CHECKER_HOME: join(base(), 'home') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('inside the installation folder');
    expect(existsSync(base())).toBe(false);
    expect(lstatSync(command(), { throwIfNoEntry: false })).toBeUndefined();
  });

  it('install refuses a data home that reaches the tree through a symlink, even one that does not resolve yet', () => {
    symlinkSync(base(), join(root, 'alias'));
    const result = install(makeBundle('0.1.0'), { PHONE_APP_CHECKER_HOME: join(root, 'alias', 'home') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('inside the installation folder');
    expect(existsSync(base())).toBe(false);
  });

  it('install refuses a configured dataDir inside the installation tree (reported by the installed CLI)', () => {
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    writeFileSync(join(base(), '0.1.0', 'marker'), 'x');
    const result = install(makeBundle('0.1.0', 'again'), { STUB_DATA_DIR: join(base(), 'current', 'store') });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('inside the installation folder');
    expect(existsSync(join(base(), '0.1.0', 'marker'))).toBe(true);
  });

  it('plain uninstall refuses (data would be deleted with the tree), removes nothing, and says so', () => {
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    const nested = join(base(), '0.1.0', 'my-data');
    mkdirSync(nested);
    writeFileSync(join(nested, 'checker.config.json'), '{}');
    const result = run(join(base(), 'current', 'uninstall.sh'), [], { env: { PHONE_APP_CHECKER_HOME: nested } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('uninstalling would delete the data too');
    expect(existsSync(join(nested, 'checker.config.json'))).toBe(true);
    expect(lstatSync(command()).isSymbolicLink()).toBe(true);
  });

  it('uninstall refuses a configured external dataDir inside the installation tree', () => {
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    const inside = join(base(), '0.1.0', 'store');
    mkdirSync(inside);
    const result = run(join(base(), 'current', 'uninstall.sh'), [], { env: { STUB_DATA_DIR: inside } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('uninstalling would delete the data too');
    expect(existsSync(inside)).toBe(true);
  });

  it('purge reports the retained external dataDir explicitly and prints that it is not remote logout or secure erasure', () => {
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    seedData();
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'checker.db'), 'results');

    const prompt = run(join(base(), 'current', 'uninstall.sh'), ['--purge-data'], { env: { STUB_DATA_DIR: elsewhere }, input: 'no\n' });
    expect(prompt.status).toBe(0);
    expect(prompt.stdout).toContain(`NOT deleted, external data directory: ${elsewhere}`);
    expect(prompt.stdout).toContain('does NOT log the accounts out remotely');
    expect(prompt.stdout).toContain('NOT a secure erase');
    expect(existsSync(defaultHome)).toBe(true);

    expect(install(makeBundle('0.1.0', 'again')).status).toBe(0);
    const purge = run(join(base(), 'current', 'uninstall.sh'), ['--purge-data', '--yes'], { env: { STUB_DATA_DIR: elsewhere } });
    expect(purge.status, purge.stderr).toBe(0);
    expect(existsSync(defaultHome)).toBe(false);
    expect(readFileSync(join(elsewhere, 'checker.db'), 'utf8')).toBe('results');
    expect(purge.stdout).toContain(`Kept, NOT deleted`);
    expect(purge.stdout).toContain(elsewhere);
    expect(purge.stdout).toContain('does NOT log the accounts out remotely');
    expect(purge.stdout).toContain('NOT a secure erase');
  });

  it('purge says nothing about a retained directory when dataDir is inside the deleted home, but still prints the caveat', () => {
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    seedData();
    const purge = run(join(base(), 'current', 'uninstall.sh'), ['--purge-data', '--yes'], { env: { STUB_DATA_DIR: join(defaultHome, 'data') } });
    expect(purge.status, purge.stderr).toBe(0);
    expect(purge.stdout).not.toContain('Kept, NOT deleted');
    expect(purge.stdout).toContain('NOT a secure erase');
  });

  it('a plain uninstall reports an external dataDir as kept', () => {
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    const result = run(join(base(), 'current', 'uninstall.sh'), [], { env: { STUB_DATA_DIR: elsewhere } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`external data directory ${elsewhere}`);
  });

  describe('configured dataDir is read BEFORE anything is deleted, also without the installed program', () => {
    /** An external data folder, a home whose config points at it, and the program installed from `bundle`. */
    function installedWithExternalData(bundle: string): string {
      expect(install(bundle).status).toBe(0);
      const elsewhere = join(root, 'elsewhere');
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, 'checker.db'), 'results');
      mkdirSync(join(defaultHome, 'data'), { recursive: true });
      writeFileSync(join(defaultHome, 'checker.config.json'), JSON.stringify({ dataDir: elsewhere }));
      return elsewhere;
    }

    it('ordinary uninstall, then a bundle-based purge: the external dataDir is still reported and kept, only the home is deleted', () => {
      const bundle = makeBundle('0.1.0');
      const elsewhere = installedWithExternalData(bundle);
      const plain = run(join(base(), 'current', 'uninstall.sh'), [], { env: { STUB_DATA_DIR: elsewhere } });
      expect(plain.status, plain.stderr).toBe(0);
      expect(existsSync(base())).toBe(false); // no installed launcher any more: nothing can answer `data-dir`

      const declined = run(join(bundle, 'uninstall.sh'), ['--purge-data'], { input: 'no\n' });
      expect(declined.status, declined.stderr).toBe(0);
      expect(declined.stdout).toContain(`NOT deleted, external data directory: ${realpathSync(elsewhere)}`); // warned BEFORE the confirmation
      expect(existsSync(defaultHome)).toBe(true);

      const purge = run(join(bundle, 'uninstall.sh'), ['--purge-data', '--yes']);
      expect(purge.status, purge.stderr).toBe(0);
      expect(existsSync(defaultHome)).toBe(false);
      expect(purge.stdout).toContain('Kept, NOT deleted');
      expect(purge.stdout).toContain(realpathSync(elsewhere));
      expect(readFileSync(join(elsewhere, 'checker.db'), 'utf8')).toBe('results');
      expect(readdirSync(elsewhere)).toEqual(['checker.db']);
    });

    it('a relative dataDir that leaves the home is reported as kept; one inside the home is deleted with it and not reported', () => {
      const bundle = makeBundle('0.1.0');
      expect(install(bundle).status).toBe(0);
      expect(run(join(base(), 'current', 'uninstall.sh')).status).toBe(0);
      const outside = join(home, 'Library', 'Application Support', 'outside');
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, 'checker.db'), 'results');
      mkdirSync(defaultHome, { recursive: true });
      writeFileSync(join(defaultHome, 'checker.config.json'), JSON.stringify({ dataDir: '../outside' }));
      const purge = run(join(bundle, 'uninstall.sh'), ['--purge-data', '--yes']);
      expect(purge.status, purge.stderr).toBe(0);
      expect(purge.stdout).toContain('Kept, NOT deleted');
      expect(purge.stdout).toContain(realpathSync(outside));
      expect(readFileSync(join(outside, 'checker.db'), 'utf8')).toBe('results');

      mkdirSync(join(defaultHome, 'store'), { recursive: true });
      writeFileSync(join(defaultHome, 'checker.config.json'), JSON.stringify({ dataDir: './store' }));
      const inside = run(join(bundle, 'uninstall.sh'), ['--purge-data', '--yes']);
      expect(inside.status, inside.stderr).toBe(0);
      expect(inside.stdout).not.toContain('Kept, NOT deleted');
      expect(existsSync(defaultHome)).toBe(false);
    });

    it.each([
      ['not a plain string', '{"dataDir":["a"]}'],
      ['a null value', '{"dataDir":null}'],
      ['invalid JSON', '{"dataDir":"a",'],
      ['a top-level array', '[{"dataDir":"a"}]'],
    ])('a dataDir that cannot be read with certainty (%s) refuses the purge before anything is removed and keeps the config', (_name, config) => {
      expect(install(makeBundle('0.1.0')).status).toBe(0);
      mkdirSync(join(defaultHome, 'data'), { recursive: true });
      writeFileSync(join(defaultHome, 'checker.config.json'), config);
      writeFileSync(join(defaultHome, 'data', 'checker.db'), 'results');

      for (const options of [{ args: ['--purge-data', '--yes'], input: '' }, { args: ['--purge-data'], input: 'DELETE\n' }]) {
        const result = run(join(base(), 'current', 'uninstall.sh'), options.args, { input: options.input });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('sets a dataDir but its location could not be determined');
        expect(result.stderr).toContain(join(defaultHome, 'checker.config.json'));
        expect(result.stdout).not.toContain('Type DELETE'); // refused before the confirmation
        expect(readFileSync(join(defaultHome, 'checker.config.json'), 'utf8')).toBe(config);
        expect(readFileSync(join(defaultHome, 'data', 'checker.db'), 'utf8')).toBe('results');
        expect(existsSync(join(base(), '0.1.0'))).toBe(true); // nothing at all was uninstalled
        expect(lstatSync(command()).isSymbolicLink()).toBe(true);
      }

      // Without --purge-data nothing is deleted from the data, and the unreadable setting is mentioned.
      const plain = run(join(base(), 'current', 'uninstall.sh'));
      expect(plain.status, plain.stderr).toBe(0);
      expect(plain.stdout).toContain('sets a dataDir that could not be read reliably');
      expect(readFileSync(join(defaultHome, 'data', 'checker.db'), 'utf8')).toBe('results');
    });

    describe('the config is read with a real JSON parser, never by a text search', () => {
      /** Installs from `bundle`, removes the program with an ordinary uninstall, and leaves `config` in the home. */
      function afterOrdinaryUninstall(bundle: string, config: string): void {
        expect(install(bundle).status).toBe(0);
        expect(run(join(base(), 'current', 'uninstall.sh')).status).toBe(0);
        expect(existsSync(base())).toBe(false);
        mkdirSync(join(defaultHome, 'data'), { recursive: true });
        writeFileSync(join(defaultHome, 'checker.config.json'), config);
      }
      const hasOsascript = existsSync('/usr/bin/osascript');

      /** The same bundle without its Node, so the system's osascript (JavaScriptCore) is the parser. */
      function withoutBundledNode(bundle: string): void {
        rmSync(join(bundle, 'runtime', 'bin', 'node'));
      }

      function elsewhereDir(): string {
        const elsewhere = join(root, 'elsewhere');
        mkdirSync(elsewhere);
        writeFileSync(join(elsewhere, 'checker.db'), 'results');
        return elsewhere;
      }

      function expectExternalKept(config: (elsewhere: string) => string, variant: (bundle: string) => void = () => {}): void {
        const bundle = makeBundle('0.1.0');
        const elsewhere = elsewhereDir();
        afterOrdinaryUninstall(bundle, config(elsewhere));
        variant(bundle);
        const declined = run(join(bundle, 'uninstall.sh'), ['--purge-data'], { input: 'no\n' });
        expect(declined.status, declined.stderr).toBe(0);
        expect(declined.stdout).toContain(`NOT deleted, external data directory: ${realpathSync(elsewhere)}`); // warned BEFORE the confirmation
        expect(existsSync(defaultHome)).toBe(true);
        const purge = run(join(bundle, 'uninstall.sh'), ['--purge-data', '--yes']);
        expect(purge.status, purge.stderr).toBe(0);
        expect(purge.stdout).toContain('Kept, NOT deleted');
        expect(purge.stdout).toContain(realpathSync(elsewhere));
        expect(existsSync(defaultHome)).toBe(false);
        expect(readFileSync(join(elsewhere, 'checker.db'), 'utf8')).toBe('results');
      }

      function expectRefusedAndKept(config: string, variant: (bundle: string) => void): void {
        const bundle = makeBundle('0.1.0');
        afterOrdinaryUninstall(bundle, config);
        writeFileSync(join(defaultHome, 'data', 'checker.db'), 'results');
        variant(bundle);
        for (const options of [{ args: ['--purge-data', '--yes'], input: '' }, { args: ['--purge-data'], input: 'DELETE\n' }]) {
          const result = run(join(bundle, 'uninstall.sh'), options.args, { input: options.input });
          expect(result.status).toBe(1);
          expect(result.stderr).toContain('sets a dataDir but its location could not be determined');
          expect(result.stdout).not.toContain('Type DELETE');
          expect(readFileSync(join(defaultHome, 'checker.config.json'), 'utf8')).toBe(config);
          expect(readFileSync(join(defaultHome, 'data', 'checker.db'), 'utf8')).toBe('results');
        }
      }

      /** Copies of the script whose osascript path does not exist: the "no trusted parser" machine. */
      function withoutOsascript(bundle: string): void {
        const script = join(bundle, 'uninstall.sh');
        const text = readFileSync(script, 'utf8');
        expect(text).toContain('JSON_OSASCRIPT=/usr/bin/osascript');
        writeFileSync(script, text.replace('JSON_OSASCRIPT=/usr/bin/osascript', 'JSON_OSASCRIPT=/nonexistent/osascript'));
      }

      it('escaped key {"\\u0064ataDir":"/x"} after an ordinary uninstall: the bundled Node still finds the external dataDir', () => {
        expectExternalKept((elsewhere) => `{"\\u0064ataDir":${JSON.stringify(elsewhere)}}`);
      });

      it.skipIf(!hasOsascript)('the same escaped key is found by osascript when the bundle has no Node', () => {
        expectExternalKept((elsewhere) => `{"\\u0064ataDir":${JSON.stringify(elsewhere)}}`, withoutBundledNode);
      });

      it.each([
        ['several mentions, the last top-level one wins (as JSON.parse does)', (e: string) => `{"dataDir":"a","apps":{"zalo":{"dataDir":"b"}},"\\u0064ataDir":${JSON.stringify(e)}}`],
        ['the value on another line', (e: string) => `{\n  "dataDir":\n    ${JSON.stringify(e)}\n}`],
        ['a BOM, an escaped value and surrounding whitespace', (e: string) => `\uFEFF \n{ "dataDir" : "${e.replace(/\//g, '\\u002f')}" }\n`],
      ])('a valid but unusual config (%s) is read correctly', (_name, config) => {
        expectExternalKept(config);
      });

      it('a nested mention only is not a top-level dataDir: the data home is purged without any warning', () => {
        const bundle = makeBundle('0.1.0');
        afterOrdinaryUninstall(bundle, '{"apps":{"zalo":{"dataDir":"/elsewhere"}}}');
        const purge = run(join(bundle, 'uninstall.sh'), ['--purge-data', '--yes']);
        expect(purge.status, purge.stderr).toBe(0);
        expect(purge.stdout).not.toContain('Kept, NOT deleted');
        expect(existsSync(defaultHome)).toBe(false);
      });

      it('an ordinary config without dataDir is purged as before', () => {
        const bundle = makeBundle('0.1.0');
        afterOrdinaryUninstall(bundle, '{"defaultRegion":"VN"}');
        const purge = run(join(bundle, 'uninstall.sh'), ['--purge-data', '--yes']);
        expect(purge.status, purge.stderr).toBe(0);
        expect(existsSync(defaultHome)).toBe(false);
      });

      it('fails closed when no trusted parser exists: the escaped key is not mistaken for "no dataDir"', () => {
        expectRefusedAndKept('{"\\u0064ataDir":"/x"}', (bundle) => {
          withoutBundledNode(bundle);
          withoutOsascript(bundle);
        });
      });

      it('fails closed when no trusted parser exists, even for a config that mentions no dataDir at all', () => {
        expectRefusedAndKept('{"defaultRegion":"VN"}', (bundle) => {
          withoutBundledNode(bundle);
          withoutOsascript(bundle);
        });
      });

      it('fails closed when the config cannot be read', () => {
        const bundle = makeBundle('0.1.0');
        afterOrdinaryUninstall(bundle, '{"dataDir":"/x"}');
        writeFileSync(join(defaultHome, 'data', 'checker.db'), 'results');
        chmodSync(join(defaultHome, 'checker.config.json'), 0o000);
        try {
          const result = run(join(bundle, 'uninstall.sh'), ['--purge-data', '--yes']);
          // root can read any file: then the config is read and /x reported instead of refusing
          if (process.getuid?.() !== 0) {
            expect(result.status).toBe(1);
            expect(result.stderr).toContain('sets a dataDir but its location could not be determined');
          }
        } finally {
          chmodSync(join(defaultHome, 'checker.config.json'), 0o600);
        }
        expect(readFileSync(join(defaultHome, 'data', 'checker.db'), 'utf8')).toBe('results');
      });

      it('a plain uninstall with no trusted parser keeps everything and says the setting could not be read', () => {
        const bundle = makeBundle('0.1.0');
        expect(install(bundle).status).toBe(0);
        mkdirSync(join(defaultHome, 'data'), { recursive: true });
        writeFileSync(join(defaultHome, 'checker.config.json'), '{"\\u0064ataDir":"/x"}');
        writeFileSync(join(defaultHome, 'data', 'checker.db'), 'results');
        withoutBundledNode(bundle);
        withoutOsascript(bundle);
        const plain = run(join(bundle, 'uninstall.sh'));
        expect(plain.status, plain.stderr).toBe(0);
        expect(plain.stdout).toContain('sets a dataDir that could not be read reliably');
        expect(readFileSync(join(defaultHome, 'data', 'checker.db'), 'utf8')).toBe('results');
        expect(existsSync(join(defaultHome, 'checker.config.json'))).toBe(true);
      });
    });
  });

  it('with the real CLI: bootstrap refuses Documents, so purge never meets a marker there', () => {
    expect(install(realCliBundle('0.1.0')).status).toBe(0);
    const documents = join(home, 'Documents');
    mkdirSync(documents);
    writeFileSync(join(documents, 'sentinel.txt'), 'precious');
    const result = run(command(), ['accounts'], { env: { PHONE_APP_CHECKER_HOME: documents } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('your Documents folder');
    expect(readdirSync(documents)).toEqual(['sentinel.txt']);
  });
});

describe.skipIf(process.platform !== 'darwin')('~/.zprofile created by the installer', () => {
  const uninstall = () => run(join(base(), 'current', 'uninstall.sh'));

  it('uninstall removes it again when this installer created it and only its PATH block was ever in it', () => {
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    expect(existsSync(zprofile())).toBe(true);
    const result = uninstall();
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(zprofile())).toBe(false);
    expect(result.stdout).toContain('Removed empty file');
  });

  it('keeps it when anything else is in it', () => {
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    writeFileSync(zprofile(), `${readFileSync(zprofile(), 'utf8')}\nexport KEEP=1\n`);
    expect(uninstall().status).toBe(0);
    expect(readFileSync(zprofile(), 'utf8')).toContain('export KEEP=1');
    expect(readFileSync(zprofile(), 'utf8')).not.toContain(BEGIN);
  });

  it('never removes a file that existed before the install, even an empty one', () => {
    writeFileSync(zprofile(), '');
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    expect(readFileSync(zprofile(), 'utf8')).toContain(BEGIN);
    expect(uninstall().status).toBe(0);
    expect(existsSync(zprofile())).toBe(true);
    expect(readFileSync(zprofile(), 'utf8')).toBe('');
  });

  it('a file that was created by an earlier run but is not recorded (older install) is left alone', () => {
    expect(install(makeBundle('0.1.0')).status).toBe(0);
    rmSync(join(base(), '.created-profiles'));
    expect(uninstall().status).toBe(0);
    expect(existsSync(zprofile())).toBe(true);
    expect(readFileSync(zprofile(), 'utf8')).toBe('');
  });
});
