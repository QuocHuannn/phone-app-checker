import { randomBytes } from 'node:crypto';
import { closeSync, constants, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LOCK_FILE = 'check.lock';
/** Serialises stale-lock recovery; present only for the instant a recovery is in progress. */
export const RECLAIM_FILE = 'check.lock.reclaim';

export interface RunLock {
  readonly path: string;
  /** Remove the lock file when it is still ours. Idempotent. */
  release(): void;
}

/** Pause points that let tests freeze a process inside the protocol. Never set in production. */
export interface LockTestHooks {
  /** The lock content is written to a private temp file; called just before it is published. */
  beforePublish?: () => void;
  /** This process now holds the reclaim guard; called before the stale owner is validated. */
  afterGuardAcquired?: () => void;
  /** The reclaim guard is held and the stale owner re-validated; called just before the unlink. */
  afterStaleValidated?: () => void;
  /** The stale lock was unlinked; called while the reclaim guard is still held. */
  afterStaleRemoved?: () => void;
  /** An abandoned reclaim guard was observed; called just before the run is refused. */
  afterGuardObserved?: () => void;
}

export interface LockOptions {
  /** Process id written to the lock file (default: this process). */
  pid?: number;
  /** Liveness probe for the pid in an existing lock (default: signal 0). */
  isAlive?: (pid: number) => boolean;
  testHooks?: LockTestHooks;
}

/** One lock attempt per tick; contention on the reclaim guard lasts microseconds, so ~2 s is generous. */
const MAX_ATTEMPTS = 100;
const RETRY_DELAY_MS = 20;

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/**
 * Owner pid recorded in `path`: undefined = no file, -1 = readable file without a usable owner.
 * Any other read failure (EACCES, EIO, EISDIR, ...) is thrown: a lock that cannot be read must never
 * be mistaken for a stale one.
 */
function readLockPid(path: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw new Error(
      `Cannot read the lock ${path} (${errorCode(error) ?? 'read error'}); refusing to guess whether it is stale. ` +
        'Fix its permissions, or make sure no phone-app-checker command is running and delete it.',
      { cause: error },
    );
  }
  try {
    const parsed = JSON.parse(text) as { pid?: unknown } | null;
    const pid = parsed?.pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : -1;
  } catch {
    return -1;
  }
}

/** Best-effort read for cleanup paths, where "cannot read" simply means "leave it alone". */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Write all of `content`: a short write (disk pressure, signal) must not publish a truncated lock. */
export function writeFully(fd: number, content: string, write: (fd: number, buffer: Buffer, offset: number) => number = writeSync): void {
  const bytes = Buffer.from(content, 'utf8');
  let written = 0;
  while (written < bytes.length) written += write(fd, bytes, written);
}

/**
 * Atomically publish `content` at `path` if nothing exists there. The bytes are written to a private
 * temp file first and then hard-linked into place, so no process can ever observe a lock file that is
 * created but not yet filled in (and a creator paused at any point never holds a half-lock).
 */
function tryPublish(path: string, content: string, beforePublish?: () => void): boolean {
  const tmp = `${path}.tmp.${process.pid}.${randomBytes(6).toString('hex')}`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    try {
      writeFully(fd, content);
    } finally {
      closeSync(fd);
    }
    beforePublish?.();
    try {
      linkSync(tmp, path);
      return true;
    } catch (error) {
      if (errorCode(error) === 'EEXIST') return false;
      throw error;
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // Already gone; nothing to clean.
    }
  }
}

function newToken(pid: number): string {
  return `${JSON.stringify({ pid, token: randomBytes(8).toString('hex'), startedAt: new Date().toISOString() })}\n`;
}

/**
 * A reclaim guard that is still there while its owner is gone means a process died inside the short
 * recovery critical section. It is NOT broken automatically: moving or deleting a guard cannot be
 * made safe against another reclaimer replacing it in between (two reclaimers could then both
 * validate the same stale lock and the later unlink would delete a fresh lock). A person who has
 * made sure no phone-app-checker command is running removes it.
 */
function abandonedGuardError(guard: string, owner: number, path: string): Error {
  return new Error(
    `Lock recovery was interrupted: ${guard} was left by a process that is no longer running` +
      (owner > 0 ? ` (pid ${owner})` : '') +
      `, so the stale lock ${path} cannot be cleaned up safely. ` +
      `Repair: make sure no phone-app-checker command is running; if nothing is running, delete ${guard} and run the command again.`,
  );
}

/**
 * Remove the stale lock at `path` (owner `owner` not running) under the exclusive reclaim guard.
 * Returns false when a live process holds the guard (caller retries). While the guard is held the
 * lock path cannot change hands: acquirers can only publish when the path is absent, other
 * reclaimers are locked out, and nobody removes a guard they did not create, so the re-check below
 * and the unlink act on the lock we validated. An abandoned guard throws (see abandonedGuardError).
 */
function reclaimStale(path: string, owner: number, isAlive: (pid: number) => boolean, pid: number, hooks?: LockTestHooks): boolean {
  const guard = join(dirname(path), RECLAIM_FILE);
  const mine = newToken(pid);
  if (!tryPublish(guard, mine)) {
    const guardOwner = readLockPid(guard);
    if (guardOwner === undefined) return false; // released meanwhile: retry at once
    if (guardOwner > 0 && isAlive(guardOwner)) return false; // someone is recovering right now
    hooks?.afterGuardObserved?.();
    throw abandonedGuardError(guard, guardOwner, path);
  }
  try {
    hooks?.afterGuardAcquired?.();
    const current = readLockPid(path);
    if (current === owner && !(owner > 0 && isAlive(owner))) {
      hooks?.afterStaleValidated?.();
      try {
        unlinkSync(path);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      hooks?.afterStaleRemoved?.();
    }
  } finally {
    // Only drop a guard that is still ours.
    if (readText(guard) === mine) {
      try {
        unlinkSync(guard);
      } catch {
        // Already gone.
      }
    }
  }
  return true;
}

/**
 * Take the exclusive lock in `dataDir` shared by `check`, `login` and `account-reset` (owner pid in
 * a file published atomically by hard link). A lock whose process is gone is recovered under a
 * separate exclusive reclaim guard; a live one fails with its pid so two runs never share accounts
 * or sessions. The lock is also removed on process exit (covers signals handled by process.exit).
 *
 * Recovery is the only step that deletes a lock it did not create. It runs one reclaimer at a time
 * and re-reads the owner under the guard, so two processes recovering the same stale lock cannot
 * both succeed and the loser can no longer delete the winner's fresh lock. Guards are never broken
 * automatically; a crash inside the recovery section fails closed with a repair message. An
 * operator deleting the lock file by hand in the middle of a recovery is the one way left to lose it.
 */
export function acquireRunLock(dataDir: string, options: LockOptions = {}): RunLock {
  const path = join(dataDir, LOCK_FILE);
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processExists;
  const hooks = options.testHooks;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (tryPublish(path, `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`, hooks?.beforePublish)) {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        process.off('exit', release);
        try {
          // Only remove a lock that still names this process (never one taken over after a crash).
          if (readLockPid(path) === pid) unlinkSync(path);
        } catch {
          // Already removed by an operator or unreadable; nothing left to clean.
        }
      };
      process.on('exit', release);
      return { path, release };
    }

    const owner = readLockPid(path);
    if (owner === undefined) continue; // vanished between EEXIST and read: retry at once
    if (owner > 0 && isAlive(owner)) {
      throw new Error(
        `Another check or login is already running (pid ${owner}, lock ${path}). Wait for it to finish; ` +
          `if nothing is running, delete ${path} (the pid may have been reused after a crash or power cut).`,
      );
    }
    if (!reclaimStale(path, owner, isAlive, pid, hooks)) sleep(RETRY_DELAY_MS);
  }
  const guard = join(dataDir, RECLAIM_FILE);
  throw new Error(
    `Could not acquire the run lock ${path}: another check is starting at the same time, or the recovery guard ${guard} is held by a live process. ` +
      `Try again. If nothing is running, delete ${guard} (its pid may have been reused after a crash or power cut), then run the command again.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Lifecycle exclusion: install.sh / uninstall.sh (maintenance) versus every CLI command.
//
// One directory per user, outside every tree that install, reinstall or purge replaces, so it works
// for any PHONE_APP_CHECKER_HOME, --config or external dataDir:
//   <dir>/shared/<pid>.<token>   one file per running command (shared hold)
//   <dir>/maintenance.lock       exclusive barrier published by install.sh / uninstall.sh
// A command registers its file FIRST and only then looks for the barrier; maintenance publishes the
// barrier FIRST and only then looks for registered commands. Both sides write before they read, so
// they cannot miss each other. Registrations of dead processes are ignored by maintenance (and
// deleted there). A barrier whose owner died is never broken: everything fails closed until a
// person has checked that nothing runs and removed it (see barrierError).
// release/install.sh and release/uninstall.sh implement the maintenance side of the same protocol.
// ---------------------------------------------------------------------------------------------

export const LIFECYCLE_DIR_NAME = 'phone-app-checker-lifecycle';
export const LIFECYCLE_BARRIER = 'maintenance.lock';
export const LIFECYCLE_SHARED = 'shared';

/** Same location the shell scripts use (`$HOME/Library/Application Support/...` on macOS). */
export function lifecycleDir(home: string = process.env.HOME || homedir()): string {
  return process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', LIFECYCLE_DIR_NAME)
    : join(home, '.local', 'state', LIFECYCLE_DIR_NAME);
}

export interface LifecycleHold {
  /** Remove this command's registration. Idempotent. */
  release(): void;
}

export interface LifecycleOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
  /** Called after the registration is published and before the barrier is read. Tests only. */
  afterRegistered?: () => void;
}

function barrierError(barrier: string, owner: number, alive: boolean): Error {
  if (alive) {
    // "Alive" also covers a pid that was reused after a crash or reboot (and EPERM), which cannot be told
    // apart from the real owner here: the message must say how a person gets out.
    return new Error(
      `An install or uninstall of phone-app-checker is in progress (pid ${owner}, ${barrier}); nothing was opened. ` +
        'Wait for it to finish, then run the command again. ' +
        `If nothing is running, delete ${barrier} (the pid may have been reused after a crash or power cut; check with: ps -p ${owner}) and run the command again.`,
    );
  }
  return new Error(
    `An earlier install or uninstall of phone-app-checker was interrupted: ${barrier} was left by ` +
      (owner > 0 ? `pid ${owner}, which is no longer running` : 'a process that cannot be identified') +
      '. Nothing was opened. ' +
      `Repair: make sure no install.sh / uninstall.sh and no other phone-app-checker command is running; if nothing is running, delete ${barrier}. ` +
      'If the installation looks incomplete afterwards, run install.sh from the downloaded bundle again.',
  );
}

/**
 * Register this process as a running command. Throws when maintenance holds (or abandoned) the
 * barrier; the caller must do so BEFORE it creates, reads or writes anything of the app.
 */
export function acquireLifecycleShared(dir: string, options: LifecycleOptions = {}): LifecycleHold {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processExists;
  const shared = join(dir, LIFECYCLE_SHARED);
  const mine = join(shared, `${pid}.${randomBytes(8).toString('hex')}`);

  // A finishing uninstall may remove the (then empty) directories between mkdir and publish: retry.
  for (let attempt = 0; ; attempt++) {
    mkdirSync(shared, { recursive: true, mode: 0o700 });
    try {
      if (!tryPublish(mine, newToken(pid))) throw new Error(`Could not register in ${shared}`);
      break;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT' || attempt >= 3) throw error;
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    try {
      unlinkSync(mine);
    } catch {
      // Already removed (a finished maintenance run cleans registrations of dead processes).
    }
  };
  try {
    options.afterRegistered?.();
    const barrier = join(dir, LIFECYCLE_BARRIER);
    const owner = readLockPid(barrier);
    if (owner !== undefined) throw barrierError(barrier, owner, owner > 0 && isAlive(owner));
  } catch (error) {
    release();
    throw error;
  }
  process.on('exit', release);
  return { release };
}
