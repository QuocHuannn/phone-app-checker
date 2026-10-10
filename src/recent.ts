import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The remembered CSVs: newest first, at most five. */
export interface RecentEntry {
  /** Absolute path of the CSV the user checked or rebuilt a report from. */
  path: string;
  /** Epoch milliseconds of the last use. */
  at: number;
}

interface RecentFile {
  /** False once the user chose "clear and stop remembering": nothing is recorded again. */
  enabled: boolean;
  files: RecentEntry[];
}

const RECENT_LIMIT = 5;
const FILE_NAME = 'recent-files.json';
/** Open flag that refuses to follow a symlink in the last path component (POSIX only). */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function parseRecent(text: string): RecentFile | undefined {
  try {
    const raw = JSON.parse(text) as Partial<RecentFile>;
    const files = (raw.files ?? [])
      .filter((entry): entry is RecentEntry => typeof entry?.path === 'string' && typeof entry?.at === 'number')
      .slice(0, RECENT_LIMIT);
    return { enabled: raw.enabled !== false, files };
  } catch {
    return undefined;
  }
}

/**
 * The last CSV files used, kept in a private (600) JSON file inside the data directory: paths and
 * timestamps only, never file contents. Every method is safe on a read-only or missing file —
 * listing is empty, recording silently stops — so the menu never breaks over it. `null` is returned
 * only when even the directory cannot be prepared.
 */
export function openRecentFiles(dataDir: string): RecentFiles | null {
  const dir = resolve(dataDir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fd = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
    return new RecentFiles(dir);
  } catch {
    return null;
  }
}

export class RecentFiles {
  private readonly file: string;
  private state: RecentFile | undefined;

  /** `dir` must already be a private directory (the data directory or the app home). */
  constructor(dir: string) {
    this.file = join(dir, FILE_NAME);
  }

  private read(): RecentFile {
    if (this.state === undefined) {
      let text = '';
      try {
        text = readFileSync(this.file, 'utf8');
      } catch {
        // Missing or unreadable file: nothing remembered yet.
      }
      this.state = text === '' ? { enabled: true, files: [] } : (parseRecent(text) ?? { enabled: true, files: [] });
    }
    return this.state;
  }

  /** Mode-600 write; a first write creates the file exclusively, later ones rewrite it. */
  private write(state: RecentFile): void {
    this.state = state;
    let fd: number;
    try {
      fd = openSync(this.file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o600);
    } catch {
      return; // Nothing writable here: remembering is best-effort.
    }
    try {
      writeSync(fd, `${JSON.stringify(state)}\n`);
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  }

  /** Whether remembering is still on (false after {@link disable}). */
  get enabled(): boolean {
    return this.read().enabled;
  }

  /** The remembered paths, missing files dropped (the drop is persisted), newest first. */
  list(): RecentEntry[] {
    const state = this.read();
    const files = state.files.filter((entry) => statSync(entry.path, { throwIfNoEntry: false })?.isFile() === true);
    if (files.length !== state.files.length) this.write({ ...state, files });
    return files;
  }

  /** The paths a picker can offer without checking them again: existing or not, marked by `exists`. */
  listWithMissing(): (RecentEntry & { exists: boolean })[] {
    return this.read().files.map((entry) => ({ ...entry, exists: statSync(entry.path, { throwIfNoEntry: false })?.isFile() === true }));
  }

  /** Remember `path` (deduplicated, newest first, capped at five); a no-op when disabled. */
  add(path: string): void {
    const state = this.read();
    if (!state.enabled) return;
    const entry = { path: resolve(path), at: Date.now() };
    this.write({ enabled: true, files: [entry, ...state.files.filter((file) => file.path !== entry.path)].slice(0, RECENT_LIMIT) });
  }

  /** Forget everything, keep remembering. */
  clear(): void {
    this.write({ ...this.read(), files: [] });
  }

  /** Forget everything and record nothing from now on (the opt-out). */
  disable(): void {
    this.write({ enabled: false, files: [] });
  }
}
