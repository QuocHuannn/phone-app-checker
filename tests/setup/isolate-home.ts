import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

/**
 * Vitest setupFile (every test file): HOME points at a throwaway directory, so anything that resolves
 * the user's home from the environment (lifecycle registrations, default app home, child processes that
 * inherit process.env) stays out of the real `~/Library/Application Support`. PHONE_APP_CHECKER_HOME
 * would override the home, so it is cleared. Tests that need their own HOME set and restore it themselves.
 */
const isolatedHome = mkdtempSync(join(tmpdir(), 'pac-test-home-'));
process.env.HOME = isolatedHome;
delete process.env.PHONE_APP_CHECKER_HOME;

afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true });
});
