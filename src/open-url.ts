import { spawn, type ChildProcess } from 'node:child_process';

/** The only address the tool ever opens in a browser: where Telegram hands out API keys. */
export const TELEGRAM_APPS_URL = 'https://my.telegram.org/apps';

/** Fixed list; nothing typed by a user or read from a file can ever reach the `open` command. */
const ALLOWED_URLS: readonly string[] = [TELEGRAM_APPS_URL];

export interface OpenUrlDeps {
  platform?: NodeJS.Platform;
  /** Whether stdout is a terminal: a script or a pipe never gets a browser window. */
  stdoutIsTTY?: boolean;
  /** Process spawner (a test seam). */
  spawn?: (command: string, args: string[], options: { stdio: 'ignore'; detached: true }) => Pick<ChildProcess, 'once' | 'unref'>;
}

/**
 * Open `url` in the default browser with macOS `/usr/bin/open`, no shell involved (the URL is one argument).
 * Resolves true when `open` accepted the address. Refuses (false, nothing started) on other platforms, when stdout
 * is not a terminal, and for any URL that is not in the fixed list.
 */
export function openUrl(url: string, deps: OpenUrlDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const tty = deps.stdoutIsTTY ?? process.stdout.isTTY === true;
  if (platform !== 'darwin' || !tty || !ALLOWED_URLS.includes(url)) return Promise.resolve(false);
  const start = deps.spawn ?? spawn;
  const { promise, resolve } = Promise.withResolvers<boolean>();
  try {
    const child = start('/usr/bin/open', [url], { stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
    child.unref();
  } catch {
    resolve(false);
  }
  return promise;
}
