import { closeSync, constants, fchmodSync, fsyncSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/**
 * Replace `file` with `text` atomically, mode 0600: written and synced to a fresh temporary file beside
 * the target, then renamed over it, so a crash leaves either the old or the new content, and a symlink
 * planted at the target is replaced, not followed. The directory must already exist and be validated by
 * the caller. Throws on failure, after removing the temporary file.
 */
export function writePrivateFileAtomic(file: string, text: string): void {
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    try {
      const data = Buffer.from(text);
      let written = 0;
      while (written < data.length) written += writeSync(fd, data, written);
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may already be gone; the original error is the one to report.
    }
    throw error;
  }
}
