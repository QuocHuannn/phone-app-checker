import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname } from 'node:path';
import { writePrivateFileAtomic } from '../private-file.ts';
import type { Lang } from './index.ts';

/** File inside the app home that remembers the menu language (just the language code). */
export const LANG_FILE = 'menu-language';

/** A language code is at most 2 letters plus a newline; anything bigger is not ours. */
const MAX_BYTES = 64;

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * The saved language code, or `undefined` for anything that is not a plain, private file of ours:
 * missing, a symlink, not a regular file, owned by someone else, readable or writable by group or
 * others (mode other than 0600/0400-style), bigger than a few bytes, or unreadable. The app home
 * itself must be a real directory owned by this user. Never throws: a bad language file only
 * means the default language. The caller still validates the content with `parseLang`.
 */
export function readLanguageFile(file: string): string | undefined {
  try {
    const dir = lstatSync(dirname(file));
    const uid = process.getuid?.();
    if (!dir.isDirectory() || (uid !== undefined && dir.uid !== uid)) return undefined;
    const fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
      if (uid !== undefined && stat.uid !== uid) return undefined;
      if ((stat.mode & 0o077) !== 0) return undefined;
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      const length = readSync(fd, buffer, 0, buffer.length, 0);
      if (length > MAX_BYTES) return undefined;
      return buffer.toString('utf8', 0, length).trim();
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * Save `lang` atomically with mode 0600 (see `writePrivateFileAtomic`). The directory must already
 * exist and be validated by the caller (the app home). Throws on failure.
 */
export function writeLanguageFile(file: string, lang: Lang): void {
  writePrivateFileAtomic(file, `${lang}\n`);
}
