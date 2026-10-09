#!/usr/bin/env node
// Entry point for the `phone-app-checker` command. Node >= 22.18 runs the TypeScript sources directly.

// node:sqlite and (on Node 22.x) TypeScript type stripping print an ExperimentalWarning on
// every start; hide only those two.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...args) => {
  const type = typeof args[0] === 'string' ? args[0] : args[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite|Type Stripping/i.test(String(warning))) return;
  return emitWarning.call(process, warning, ...args);
};

// Dynamic import so the filter above is installed before any module loads node:sqlite.
const { main, exitWhenFlushed } = await import('../src/cli.ts');
await exitWhenFlushed(await main(process.argv));
