import { diffSnapshots, realAppSupportDir, snapshotGuarded } from '../helpers/real-home-guard.ts';

/**
 * Vitest globalSetup (main process, before any worker): remember what lives under the real
 * `~/Library/Application Support/phone-app-checker*` and fail the whole run if it changed by the end.
 */
export default function setup(): () => void {
  const before = snapshotGuarded();
  return () => {
    const changes = diffSnapshots(before, snapshotGuarded());
    if (changes.length === 0) return;
    process.exitCode = 1;
    throw new Error(
      `Tests touched the real ${realAppSupportDir()}/phone-app-checker*. Every test must run with HOME (and any lifecycle dir) in a temp dir:\n${changes.join('\n')}`,
    );
  };
}
