import { readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

/**
 * Folders of the user's own files. Neither the app home nor the data directory may be one of these:
 * both get mode 700 and are the unit that uninstall --purge-data deletes, so a marker file created
 * inside "Documents" must never make the whole of Documents look like ours. Relative to the home
 * directory; release/uninstall.sh carries the same list.
 */
export const SHARED_USER_DIRS: readonly string[] = [
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
];

/**
 * Well-known sync clients that keep a folder directly under the home directory (Dropbox, Dropbox
 * (Personal), Google Drive, OneDrive - Contoso, Box, iCloud Drive...). Matched on the folder name,
 * case-folded. Together with `Library/Mobile Documents` (iCloud Drive) and `Library/CloudStorage/*`
 * (File Provider roots: Dropbox, Google Drive, OneDrive, Box...) these are the synced folders:
 * customer numbers and live sessions must not be copied to a third party. release/uninstall.sh
 * carries the same patterns.
 */
export const SYNCED_HOME_FOLDER = /^(dropbox|onedrive|google ?drive|icloud ?drive$|box( sync| drive)?$)/i;

/**
 * Synced folders under `userHome`: the fixed iCloud/CloudStorage roots, every existing provider folder
 * directly under CloudStorage (a provider may be a symlink to a synced folder elsewhere, which
 * resolving CloudStorage itself would not reveal) and the matching home folders. Callers compare
 * both the lexical and the canonical form of each root.
 */
function syncedRoots(userHome: string): string[] {
  const cloudStorage = join(userHome, 'Library', 'CloudStorage');
  const roots = [join(userHome, 'Library', 'Mobile Documents'), cloudStorage];
  try {
    for (const entry of readdirSync(cloudStorage)) roots.push(join(cloudStorage, entry));
  } catch {
    // no CloudStorage folder (or unreadable): it has no provider folders we could name
  }
  try {
    for (const entry of readdirSync(userHome)) {
      if (SYNCED_HOME_FOLDER.test(entry)) roots.push(join(userHome, entry));
    }
  } catch {
    // an unreadable home has no sync folders we could name
  }
  return roots;
}

/** `$HOME` (what install.sh and the launcher use), else the account's home directory. */
export function userHomeDir(): string {
  return process.env.HOME || homedir();
}

/** Where install.sh puts the program; replaced on install and removed on uninstall. */
export function installTreeRoot(): string {
  return join(userHomeDir(), 'Applications', 'phone-app-checker');
}

/**
 * Physical path of `path`, also when it (or its tail) does not exist yet: the deepest existing
 * ancestor is resolved through symlinks and the missing components are appended.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = []; // deepest component first
  let current = absolute;
  for (;;) {
    try {
      return join(realpathSync(current), ...[...missing].reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return absolute;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/** macOS volumes are case-insensitive by default: compare folded so `~/documents` is `~/Documents`. */
const fold = (path: string): string => (process.platform === 'darwin' || process.platform === 'win32' ? path.toLowerCase() : path);

export function isSameOrInside(child: string, parent: string): boolean {
  const c = fold(child);
  const p = fold(parent);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export function pathsOverlap(a: string, b: string): boolean {
  return isSameOrInside(a, b) || isSameOrInside(b, a);
}

/** Same directory according to the filesystem (symlinks, case and hard aliases cannot fool it). */
function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a);
    const y = statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/**
 * Refuse a directory that must not become the app home or the data directory:
 *  - `/`, the user's home directory and any parent of it;
 *  - a synced folder (iCloud Drive, ~/Library/CloudStorage/*, Dropbox, Google Drive, OneDrive, Box) or
 *    anything inside one: customer numbers and live sessions must never be copied to a third party;
 *  - the user's own folders (Documents, Desktop, ~/.config, ...), even when a marker file is there;
 *  - anything overlapping the installation tree (replaced on install, deleted on uninstall).
 * Decided on physical paths, so symlinked ancestors and aliases cannot slip past. Call it before
 * creating or changing anything.
 */
export function assertSafeAppRoot(path: string, label: 'app home' | 'data directory'): void {
  const real = canonicalPath(path);
  const userHome = canonicalPath(userHomeDir());
  if (real === sep || sameFile(real, userHome) || isSameOrInside(userHome, real)) {
    throw new Error(`${path} is the user's home directory (or one of its parents); refusing to use it as the ${label}.`);
  }
  const syncedRoot = syncedRoots(userHome).find((root) => isSameOrInside(real, root) || isSameOrInside(real, canonicalPath(root)));
  const first = isSameOrInside(real, userHome) ? real.slice(userHome.length + 1).split(sep)[0] : undefined;
  const named = first !== undefined && SYNCED_HOME_FOLDER.test(first) ? join(userHome, first) : undefined;
  if (syncedRoot ?? named) {
    throw new Error(
      `${path} is, or lies inside, the synced folder ${syncedRoot ?? named}; customer numbers and login sessions must not live in a ` +
        `folder that iCloud/Dropbox/Google Drive/OneDrive/Box copies to the cloud; refusing to use it as the ${label}. ` +
        `Choose a local folder outside it, for example ${join(userHome, 'phone-checks')}.`,
    );
  }
  for (const relative of SHARED_USER_DIRS) {
    const shared = join(userHome, relative);
    if (sameFile(real, shared) || fold(real) === fold(shared)) {
      throw new Error(
        `${path} is your ${relative} folder, which holds your own files; refusing to use it as the ${label}. ` +
          `Use a dedicated sub-folder instead, for example ${join(path, 'phone-app-checker')}.`,
      );
    }
  }
  const tree = canonicalPath(installTreeRoot());
  if (pathsOverlap(real, tree)) {
    throw new Error(
      `${path} overlaps the installation folder ${tree}, which install.sh replaces and uninstall.sh deletes; ` +
        `refusing to use it as the ${label}. Choose a location outside it.`,
    );
  }
}
