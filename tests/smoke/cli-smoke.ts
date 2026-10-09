// Manual end-to-end smoke: `node --disable-warning=ExperimentalWarning tests/smoke/cli-smoke.ts`
// Runs the real CLI against a throwaway directory with a test-only injected adapter and prints
// what it produced. No platform credentials, no network.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSmokeScenario } from './scenario.ts';

const dir = mkdtempSync(join(tmpdir(), 'pac-smoke-'));
// Never touch the real ~/Library/Application Support/phone-app-checker*: HOME and the lifecycle dir live in `dir`.
process.env.HOME = dir;
delete process.env.PHONE_APP_CHECKER_HOME;
try {
  const result = await runSmokeScenario(dir);
  console.log('--- report.csv after run 1 (telegram throttled once, then resumed) ---');
  console.log(result.report1);
  console.log('--- adapter calls per run (run 2 = cache hit, run 3 = only the new number) ---');
  console.log(JSON.stringify(result.calls));
  console.log('--- report.csv after run 3 (new customer added) ---');
  console.log(result.report3);
  console.log('--- summary ---');
  console.log(result.summary);
  console.log('--- accounts ---');
  console.log(result.accounts);
  console.log('--- SQLite rows stored per app ---');
  console.log(JSON.stringify(result.stored));
  console.log('--- exit codes ---');
  console.log(JSON.stringify(result.exitCodes));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
