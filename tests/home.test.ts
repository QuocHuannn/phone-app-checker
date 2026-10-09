import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapHome, exampleConfigPath, packageVersion, readBuildInfo } from '../src/home.ts';
import { Store } from '../src/store.ts';

let dir: string;
let logs: string[];
const log = (message: string) => logs.push(message);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'checker-home-'));
  logs = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe('bootstrapHome', () => {
  it('creates the home (700) and a config (600) equal to the bundled example', () => {
    const home = join(dir, 'Application Support', 'phone-app-checker');
    expect(bootstrapHome(home, log)).toBe(true);
    const file = join(home, 'checker.config.json');
    expect(mode(home)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(readFileSync(file)).toEqual(readFileSync(exampleConfigPath()));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`First run: created ${file}`);
    expect(logs[0]).toContain('phone-app-checker doctor');
  });

  it('never overwrites an existing config and stays silent', () => {
    const home = join(dir, 'home');
    bootstrapHome(home, log);
    const file = join(home, 'checker.config.json');
    writeFileSync(file, '{"defaultRegion":"SG"}');
    logs.length = 0;
    expect(bootstrapHome(home, log)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('{"defaultRegion":"SG"}');
    expect(logs).toEqual([]);
  });

  it('tightens a pre-existing home directory to 700', () => {
    const home = join(dir, 'home');
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    expect(bootstrapHome(home, log)).toBe(true);
    expect(mode(home)).toBe(0o700);
  });

  it('refuses a symlinked home', () => {
    const target = join(dir, 'target');
    mkdirSync(target);
    const home = join(dir, 'link');
    symlinkSync(target, home);
    expect(() => bootstrapHome(home, log)).toThrow(/symlink/);
    expect(logs).toEqual([]);
  });

  it('refuses a home that is a regular file', () => {
    const home = join(dir, 'file');
    writeFileSync(home, '');
    expect(() => bootstrapHome(home, log)).toThrow();
  });

  it('does not follow a dangling symlink planted at the config path', () => {
    const home = join(dir, 'home');
    mkdirSync(home, { mode: 0o700 });
    const victim = join(dir, 'victim');
    symlinkSync(victim, join(home, 'checker.config.json'));
    expect(bootstrapHome(home, log)).toBe(false);
    expect(() => statSync(victim)).toThrow();
  });

  describe('refuses the user home directory and its ancestors (no chmod, no config written)', () => {
    let savedHome: string | undefined;
    beforeEach(() => {
      savedHome = process.env.HOME;
    });
    afterEach(() => {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    });

    it.each([
      ['the home directory itself', (userHome: string) => userHome],
      ['an ancestor of it', (userHome: string) => join(userHome, '..')],
    ])('%s', (_label, pick) => {
      const userHome = join(dir, 'Users', 'someone');
      mkdirSync(userHome, { recursive: true });
      chmodSync(userHome, 0o755);
      chmodSync(join(dir, 'Users'), 0o755);
      process.env.HOME = userHome;
      const target = pick(userHome);
      expect(() => bootstrapHome(target, log)).toThrow(/home directory/);
      expect(mode(userHome)).toBe(0o755);
      expect(mode(join(dir, 'Users'))).toBe(0o755);
      expect(() => statSync(join(target, 'checker.config.json'))).toThrow();
      expect(logs).toEqual([]);
    });

    it('accepts a directory below the home directory', () => {
      const userHome = join(dir, 'Users', 'someone');
      mkdirSync(userHome, { recursive: true });
      process.env.HOME = userHome;
      expect(bootstrapHome(join(userHome, 'Library', 'Application Support', 'phone-app-checker'), log)).toBe(true);
    });
  });
});

describe('packageVersion', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as { version: string };
    expect(packageVersion()).toBe(pkg.version);
  });
});

describe('readBuildInfo', () => {
  const info = {
    version: '0.1.0',
    platform: 'darwin-arm64',
    node: '24.21.0',
    nodeSha256: 'a'.repeat(64),
    lockSha256: 'b'.repeat(64),
    builtAt: '2026-10-08T10:00:00Z',
    builder: 'tester',
  };

  it('is null in a source checkout (no BUILD-INFO.json next to src/)', () => {
    expect(readBuildInfo()).toBeNull();
  });

  it('is null when the file is absent', () => {
    expect(readBuildInfo(join(dir, 'none.json'))).toBeNull();
  });

  it('parses a BUILD-INFO.json', () => {
    const file = join(dir, 'BUILD-INFO.json');
    writeFileSync(file, JSON.stringify({ ...info, extra: 1 }));
    expect(readBuildInfo(file)).toEqual(info);
  });

  it('rejects malformed or incomplete files', () => {
    const file = join(dir, 'BUILD-INFO.json');
    writeFileSync(file, '{ nope');
    expect(() => readBuildInfo(file)).toThrow(/BUILD-INFO\.json/);
    writeFileSync(file, JSON.stringify({ version: '0.1.0' }));
    expect(() => readBuildInfo(file)).toThrow(/"platform" must be a string/);
    writeFileSync(file, '[]');
    expect(() => readBuildInfo(file)).toThrow(/JSON object/);
  });
});

describe('destructive-path ownership: shared folders and the installation tree', () => {
  let savedHome: string | undefined;
  let userHome: string;
  beforeEach(() => {
    savedHome = process.env.HOME;
    userHome = join(dir, 'Users', 'someone');
    mkdirSync(userHome, { recursive: true });
    process.env.HOME = userHome;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });

  const SHARED = [
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
  ];

  describe.each([
    ['app home', (path: string) => bootstrapHome(path, log)],
    ['data directory', (path: string) => Store.open(path).close()],
  ])('as the %s', (label, use) => {
    it.each(SHARED)('refuses ~/%s (the folder itself), changes nothing', (name) => {
      const shared = join(userHome, name);
      mkdirSync(shared, { recursive: true });
      chmodSync(shared, 0o755);
      expect(() => use(shared)).toThrow(new RegExp(`your ${name} folder.*own files.*${label}`, 's'));
      expect(mode(shared)).toBe(0o755);
      expect(readdirSync(shared).filter((entry) => entry !== 'Application Support' && entry !== 'bin')).toEqual([]);
      expect(logs).toEqual([]);
    });

    it('refuses ~/Documents even when a config marker is already inside it', () => {
      const documents = join(userHome, 'Documents');
      mkdirSync(documents, { mode: 0o755 });
      chmodSync(documents, 0o755);
      writeFileSync(join(documents, 'checker.config.json'), '{}');
      writeFileSync(join(documents, 'sentinel.txt'), 'precious');
      expect(() => use(documents)).toThrow(/your Documents folder/);
      expect(mode(documents)).toBe(0o755);
      expect(readFileSync(join(documents, 'sentinel.txt'), 'utf8')).toBe('precious');
    });

    it('refuses a shared folder reached through a symlinked ancestor or another spelling', () => {
      mkdirSync(join(userHome, 'Documents'), { mode: 0o755 });
      chmodSync(join(userHome, 'Documents'), 0o755);
      symlinkSync(userHome, join(dir, 'via-link'));
      expect(() => use(join(dir, 'via-link', 'Documents'))).toThrow(/your Documents folder/);
      expect(() => use(`${userHome}/Library/../Documents/`)).toThrow(/your Documents folder/);
      expect(mode(join(userHome, 'Documents'))).toBe(0o755);
    });

    it('refuses a shared folder under another letter case on a case-insensitive volume', () => {
      mkdirSync(join(userHome, 'Documents'), { mode: 0o755 });
      const insensitive = statSync(join(userHome, 'DOCUMENTS'), { throwIfNoEntry: false }) !== undefined;
      if (!insensitive) return;
      expect(() => use(join(userHome, 'documents'))).toThrow(/your Documents folder/);
    });

    it('accepts a dedicated sub-folder of a shared folder', () => {
      const dedicated = join(userHome, 'Documents', 'phone-app-checker');
      expect(() => use(dedicated)).not.toThrow();
      expect(statSync(dedicated).isDirectory()).toBe(true);
    });

    describe('synced folders (iCloud Drive, CloudStorage, Dropbox, Google Drive, OneDrive, Box)', () => {
      it.each([
        'Library/Mobile Documents',
        'Library/Mobile Documents/com~apple~CloudDocs/phone-checker',
        'Library/CloudStorage',
        'Library/CloudStorage/Dropbox',
        'Library/CloudStorage/GoogleDrive-someone@example.com/My Drive/phone-checker',
        'Library/CloudStorage/OneDrive-Personal',
        'Library/CloudStorage/Box-Box/data',
        'Dropbox',
        'Dropbox (Personal)/phone-checker',
        'dropbox/phone-checker',
        'Google Drive/phone-checker',
        'GoogleDrive',
        'OneDrive',
        'OneDrive - Contoso/phone-checker',
        'Box',
        'Box Sync/phone-checker',
        'iCloud Drive/phone-checker',
      ])('refuses ~/%s (the synced folder or anything inside it), creates nothing', (name) => {
        const target = join(userHome, name);
        expect(() => use(target)).toThrow(
          new RegExp(`synced folder.*customer numbers and login sessions must not live.*${label}`, 's'),
        );
        expect(statSync(target, { throwIfNoEntry: false })).toBeUndefined();
        expect(logs).toEqual([]);
      });

      it('refuses an existing synced folder without changing its mode', () => {
        const dropbox = join(userHome, 'Dropbox');
        mkdirSync(dropbox, { mode: 0o755 });
        chmodSync(dropbox, 0o755);
        expect(() => use(dropbox)).toThrow(/synced folder/);
        expect(() => use(join(dropbox, 'phone-app-checker'))).toThrow(/synced folder/);
        expect(mode(dropbox)).toBe(0o755);
        expect(readdirSync(dropbox)).toEqual([]);
      });

      it('refuses a synced folder through a symlinked ancestor, a symlinked root and another letter case', () => {
        mkdirSync(join(userHome, 'Library', 'CloudStorage', 'Dropbox'), { recursive: true });
        symlinkSync(userHome, join(dir, 'via-link'));
        expect(() => use(join(dir, 'via-link', 'Library', 'CloudStorage', 'Dropbox', 'x'))).toThrow(/synced folder/);
        expect(() => use(`${userHome}/Documents/../Library/CloudStorage/Dropbox/x`)).toThrow(/synced folder/);

        const external = join(dir, 'external-sync');
        mkdirSync(external);
        symlinkSync(external, join(userHome, 'Google Drive')); // sync root that lives on another volume
        expect(() => use(join(external, 'phone-checker'))).toThrow(/synced folder/);
        expect(statSync(join(external, 'phone-checker'), { throwIfNoEntry: false })).toBeUndefined();

        if (statSync(join(userHome, 'LIBRARY'), { throwIfNoEntry: false }) !== undefined) {
          expect(() => use(join(userHome, 'library', 'cloudstorage', 'x'))).toThrow(/synced folder/);
        }
      });

      it('refuses a symlinked CloudStorage provider child and its external physical target, before creating anything or changing a mode', () => {
        const external = join(dir, 'external-dropbox'); // a synced folder on another volume, outside HOME
        mkdirSync(external, { mode: 0o755 });
        chmodSync(external, 0o755);
        mkdirSync(join(userHome, 'Library', 'CloudStorage'), { recursive: true });
        symlinkSync(external, join(userHome, 'Library', 'CloudStorage', 'Dropbox'));
        const before = readdirSync(external);

        for (const target of [
          join(external, 'phone-app-checker'), // physical target, a not-yet-existing descendant
          join(external, 'a', 'b', 'c'),
          join(userHome, 'Library', 'CloudStorage', 'Dropbox', 'phone-app-checker'), // through the provider link
          external, // the physical target itself
        ]) {
          expect(() => use(target), target).toThrow(new RegExp(`synced folder.*customer numbers and login sessions must not live.*${label}`, 's'));
        }
        expect(() => use(join(userHome, 'Library', 'CloudStorage', 'Dropbox'))).toThrow(/symlink|synced folder/); // the link itself
        expect(readdirSync(external)).toEqual(before);
        expect(mode(external)).toBe(0o755);
        expect(logs).toEqual([]);
      });

      it('refuses a provider child linked to a subfolder of an external directory, and leaves its siblings usable', () => {
        const external = join(dir, 'external-box');
        mkdirSync(join(external, 'inner'), { recursive: true });
        mkdirSync(join(userHome, 'Library', 'CloudStorage'), { recursive: true });
        symlinkSync(join(external, 'inner'), join(userHome, 'Library', 'CloudStorage', 'Box-Box'));
        expect(() => use(join(external, 'inner', 'data'))).toThrow(/synced folder/);
        expect(statSync(join(external, 'inner', 'data'), { throwIfNoEntry: false })).toBeUndefined();
        expect(() => use(join(external, 'elsewhere'))).not.toThrow(); // a sibling of the synced folder is not synced
      });

      it('accepts local folders whose names only look similar', () => {
        for (const name of ['phone-checks', 'Boxes', 'Library/Application Support/phone-app-checker']) {
          const target = join(userHome, name);
          expect(() => use(target), name).not.toThrow();
          expect(statSync(target).isDirectory()).toBe(true);
        }
      });
    });

    describe('installation tree (~/Applications/phone-app-checker)', () => {
      const tree = () => join(userHome, 'Applications', 'phone-app-checker');

      it.each([
        ['the tree itself', () => tree(), false],
        ['a folder inside it', () => join(tree(), 'home'), false],
        ['a folder inside an installed version', () => join(tree(), '0.1.0', 'data'), false],
        ['the tree under another letter case', () => join(userHome, 'applications', 'Phone-App-Checker', 'home'), true],
      ])('refuses %s before writing anything', (_name, pick, needsCaseInsensitiveVolume) => {
        if (needsCaseInsensitiveVolume) {
          // The refusal resolves existing ancestors on disk, so another spelling only matches on a case-insensitive
          // volume (macOS default); on a case-sensitive one (Linux) it is a different path and there is nothing to refuse.
          mkdirSync(join(dir, 'CaseProbe'));
          if (statSync(join(dir, 'caseprobe'), { throwIfNoEntry: false }) === undefined) return;
        }
        const target = pick();
        expect(() => use(target)).toThrow(/installation folder.*install\.sh replaces and uninstall\.sh deletes/s);
        expect(statSync(tree(), { throwIfNoEntry: false })).toBeUndefined();
        expect(logs).toEqual([]);
      });

      it('refuses it through a symlinked ancestor, also when the tree already exists', () => {
        mkdirSync(tree(), { recursive: true });
        symlinkSync(join(userHome, 'Applications'), join(dir, 'apps-alias'));
        const target = join(dir, 'apps-alias', 'phone-app-checker', 'home');
        expect(() => use(target)).toThrow(/installation folder/);
        expect(readdirSync(tree())).toEqual([]);
      });

      it('accepts a sibling whose name merely starts like the tree', () => {
        expect(() => use(join(userHome, 'Applications', 'phone-app-checker-data'))).not.toThrow();
      });
    });
  });
});

describe('Store.open validates dataDir like the app home', () => {
  it('refuses the user home directory and its parents', () => {
    const savedHome = process.env.HOME;
    const userHome = join(dir, 'Users', 'someone');
    mkdirSync(userHome, { recursive: true });
    process.env.HOME = userHome;
    try {
      expect(() => Store.open(userHome)).toThrow(/home directory/);
      expect(() => Store.open(join(userHome, '..'))).toThrow(/home directory/);
      expect(readdirSync(userHome)).toEqual([]);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});
