import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openRecentFiles, RecentFiles } from '../src/recent.ts';

let dir: string;
let data: string;

beforeEach(() => {
  // realpath: process.cwd() reports /private/var on macOS, so a relative path would otherwise resolve to another spelling of the same folder.
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'pac-recent-')));
  data = join(dir, 'data');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** A real CSV file the store can find again. */
function csv(name: string): string {
  const path = join(dir, name);
  writeFileSync(path, 'phone\n0901234567\n');
  return path;
}

const open = (): RecentFiles => {
  const files = openRecentFiles(data);
  if (files === null) throw new Error('the data directory should be usable');
  return files;
};
const stored = () => join(data, 'recent-files.json');

describe('remembering CSV files', () => {
  it('lists the newest file first and moves a re-used file to the top without a duplicate', () => {
    const [a, b, c] = [csv('a.csv'), csv('b.csv'), csv('c.csv')] as [string, string, string];
    const recent = open();
    recent.add(a);
    recent.add(b);
    recent.add(c);
    recent.add(a);
    expect(recent.list().map((entry) => entry.path)).toEqual([a, c, b]);
  });

  it('keeps only the five latest files', () => {
    const paths = Array.from({ length: 7 }, (_, i) => csv(`f${i}.csv`));
    const recent = open();
    for (const path of paths) recent.add(path);
    expect(recent.list().map((entry) => entry.path)).toEqual(paths.slice(2).reverse());
  });

  it('survives a restart: a new store over the same folder sees the same files', () => {
    const a = csv('a.csv');
    open().add(a);
    expect(open().list().map((entry) => entry.path)).toEqual([a]);
  });

  it('records when a file was used', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T08:00:00Z'));
    const a = csv('a.csv');
    const recent = open();
    recent.add(a);
    expect(recent.list()[0]?.at).toBe(Date.parse('2026-10-10T08:00:00Z'));
  });

  it('resolves a relative path so the same file is not listed twice', () => {
    const a = csv('a.csv');
    const recent = open();
    const previous = process.cwd();
    process.chdir(dir);
    try {
      recent.add('a.csv');
      recent.add(a);
    } finally {
      process.chdir(previous);
    }
    expect(recent.list().map((entry) => entry.path)).toEqual([a]);
  });
});

describe('files that disappear', () => {
  it('drops a deleted file from the list and forgets it for good', () => {
    const [a, b] = [csv('a.csv'), csv('b.csv')] as [string, string];
    const recent = open();
    recent.add(a);
    recent.add(b);
    rmSync(a);
    expect(recent.list().map((entry) => entry.path)).toEqual([b]);
    expect(JSON.parse(readFileSync(stored(), 'utf8')).files.map((entry: { path: string }) => entry.path)).toEqual([b]);
  });

  it('a folder or a missing path is never offered as a file', () => {
    const a = csv('a.csv');
    const recent = open();
    recent.add(a);
    rmSync(a);
    mkdirSync(a);
    expect(recent.list()).toEqual([]);
  });

  it('listWithMissing keeps a vanished file and marks it, without rewriting the store', () => {
    const [a, b] = [csv('a.csv'), csv('b.csv')] as [string, string];
    const recent = open();
    recent.add(a);
    recent.add(b);
    rmSync(a);
    expect(recent.listWithMissing().map((entry) => [entry.path, entry.exists])).toEqual([
      [b, true],
      [a, false],
    ]);
    expect(JSON.parse(readFileSync(stored(), 'utf8')).files).toHaveLength(2);
  });
});

describe('opting out', () => {
  it('clear forgets the files but keeps remembering new ones', () => {
    const [a, b] = [csv('a.csv'), csv('b.csv')] as [string, string];
    const recent = open();
    recent.add(a);
    recent.clear();
    expect(recent.list()).toEqual([]);
    expect(recent.enabled).toBe(true);
    recent.add(b);
    expect(recent.list().map((entry) => entry.path)).toEqual([b]);
  });

  it('disable forgets everything and records nothing afterwards, also after a restart', () => {
    const [a, b] = [csv('a.csv'), csv('b.csv')] as [string, string];
    const recent = open();
    recent.add(a);
    recent.disable();
    recent.add(b);
    expect(recent.enabled).toBe(false);
    expect(recent.list()).toEqual([]);

    const again = open();
    expect(again.enabled).toBe(false);
    again.add(b);
    expect(again.list()).toEqual([]);
  });
});

describe('privacy', () => {
  it('writes a private file in a private folder and stores paths and times only, never contents', () => {
    const a = join(dir, 'secret-customers.csv');
    writeFileSync(a, 'name,phone\nAn,0901234567\n');
    open().add(a);
    expect(statSync(stored()).mode & 0o777).toBe(0o600);
    expect(statSync(data).mode & 0o777).toBe(0o700);
    const text = readFileSync(stored(), 'utf8');
    expect(text).not.toContain('0901234567');
    expect(text).not.toContain('An,');
    expect(Object.keys(JSON.parse(text).files[0]).sort()).toEqual(['at', 'path']);
  });

  it('tightens a loose store file on the next write', () => {
    const a = csv('a.csv');
    mkdirSync(data, { recursive: true, mode: 0o700 });
    writeFileSync(stored(), '{"enabled":true,"files":[]}\n', { mode: 0o644 });
    chmodSync(stored(), 0o644);
    open().add(a);
    expect(statSync(stored()).mode & 0o777).toBe(0o600);
  });

  it('tightens a loose data folder', () => {
    mkdirSync(data, { recursive: true, mode: 0o755 });
    chmodSync(data, 0o755);
    open();
    expect(statSync(data).mode & 0o777).toBe(0o700);
  });

  it('never writes through a symlink planted where the store file goes', () => {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'keep me');
    symlinkSync(victim, stored());
    const recent = open();
    recent.add(csv('a.csv'));
    expect(readFileSync(victim, 'utf8')).toBe('keep me');
  });
});

describe('a store that cannot be trusted or written never breaks the menu', () => {
  it.each([
    ['not JSON', 'oops'],
    ['wrong shape', '{"files":"nope"}'],
    ['empty', ''],
  ])('%s: starts empty and still records', (_name, content) => {
    mkdirSync(data, { recursive: true, mode: 0o700 });
    writeFileSync(stored(), content, { mode: 0o600 });
    const a = csv('a.csv');
    const recent = open();
    expect(recent.list()).toEqual([]);
    recent.add(a);
    expect(open().list().map((entry) => entry.path)).toEqual([a]);
  });

  it('ignores damaged entries and keeps the good ones', () => {
    const a = csv('a.csv');
    mkdirSync(data, { recursive: true, mode: 0o700 });
    writeFileSync(stored(), JSON.stringify({ enabled: true, files: [{ path: 3, at: 1 }, { path: a, at: 2 }, null, { path: a }] }), { mode: 0o600 });
    expect(open().list()).toEqual([{ path: a, at: 2 }]);
  });

  it('a store file that cannot be written is silently skipped; the session still works in memory', () => {
    const a = csv('a.csv');
    const recent = open();
    mkdirSync(stored()); // a directory where the file should go: opening it for writing fails
    expect(() => recent.add(a)).not.toThrow();
    expect(recent.list().map((entry) => entry.path)).toEqual([a]);
  });

  it('returns null when the folder cannot be made', () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'a file where a folder is needed');
    expect(openRecentFiles(join(blocker, 'data'))).toBeNull();
  });
});
