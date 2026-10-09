import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The default 5 s is far below what the 2000-case fuzz loops (config, csv, report), the shell-script
    // suites and the real-process lock tests need on a loaded machine (a fuzz test took 2.9 s idle and 7.4 s
    // under load). A generous ceiling keeps `npm test` stable; a genuine hang still fails after one minute.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // node:sqlite prints an ExperimentalWarning in every worker on Node 22/24.
    execArgv: ['--disable-warning=ExperimentalWarning'],
    // No test may touch the real ~/Library/Application Support/phone-app-checker*: see tests/setup/.
    globalSetup: ['tests/setup/global-guard.ts'],
    setupFiles: ['tests/setup/isolate-home.ts'],
  },
});
