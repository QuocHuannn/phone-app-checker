import { lstatSync, readdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * Tests and smoke runs must never touch the user's real `~/Library/Application Support/phone-app-checker*`
 * (the app home and the lifecycle directory). The real home comes from the passwd database, not from
 * `$HOME`, because `$HOME` is exactly what the test setup redirects.
 */
export const GUARDED_PREFIX = 'phone-app-checker';

export function realAppSupportDir(): string {
  return join(userInfo().homedir, 'Library', 'Application Support');
}

/** `path -> "<type> <size> <mtimeMs>"` for every guarded entry (and everything below it) under `appSupport`. */
export function snapshotGuarded(appSupport: string = realAppSupportDir()): Map<string, string> {
  const seen = new Map<string, string>();
  const walk = (path: string): void => {
    const stat = lstatSync(path);
    seen.set(path, `${stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'link' : 'file'} ${stat.size} ${stat.mtimeMs}`);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry));
  };
  let entries: string[];
  try {
    entries = readdirSync(appSupport);
  } catch {
    return seen;
  }
  for (const entry of entries) if (entry.startsWith(GUARDED_PREFIX)) walk(join(appSupport, entry));
  return seen;
}

/** Human-readable differences between two snapshots; empty when nothing was created, removed or modified. */
export function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [path, state] of after) {
    const old = before.get(path);
    if (old === undefined) changes.push(`created  ${path}`);
    else if (old !== state) changes.push(`modified ${path}`);
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push(`removed  ${path}`);
  return changes.sort();
}
