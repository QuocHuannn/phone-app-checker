// Cold-start benchmark: every sample is a fresh process; the table prints median (min..max) wall
// ms and the last sample's peak RSS. Runs the TypeScript entry (`bin/phone-app-checker.js`) and,
// when it exists, the compiled bundle `build/js/bin/phone-app-checker.js` from `npm run build`.
//   node --disable-warning=ExperimentalWarning bench/startup.ts [runs] [--repo path]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_REPO = resolve(join(BENCH_DIR, '..'));
const OUT_DIR = join(BENCH_DIR, 'out');

let runs = 11;
let repo = DEFAULT_REPO;
for (let i = 0; i < process.argv.length - 2; i += 1) {
  const arg = process.argv[i + 2]!;
  if (arg === '--repo') {
    repo = resolve(process.argv[i + 3]!);
    i += 1;
  } else if (/^\d+$/.test(arg)) runs = Number(arg);
}

// Fresh HOME and cwd so nothing touches the real app home, config or data directory.
const work = mkdtempSync(join(tmpdir(), 'pac-bench-startup-'));
const home = join(work, 'home');
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NO_COLOR: '1', FORCE_COLOR: '0' };
delete env.PHONE_APP_CHECKER_HOME;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/** One fresh process; returns wall ms (hrtime around the spawn) and peak RSS via /usr/bin/time -l. */
function sample(argv: string[]): { wall: number; rssMB: number; status: number | null } {
  const t0 = process.hrtime.bigint();
  const result = spawnSync('/usr/bin/time', ['-l', ...argv], { cwd: work, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  const rss = /(\d+)\s+maximum resident set size/.exec(result.stderr ?? '');
  return { wall, rssMB: rss ? Number(rss[1]) / 1048576 : NaN, status: result.status };
}

const entries: { name: string; samples: { wall: number; rssMB: number; status: number | null }[] }[] = [];
const cli = join(repo, 'bin/phone-app-checker.js');
const compiledCli = join(repo, 'build/js/bin/phone-app-checker.js');

const cases: [string, string[]][] = [
  ['node -e 0 (baseline)', [process.execPath, '-e', '0']],
  ['-V', [process.execPath, '--disable-warning=ExperimentalWarning', cli, '-V']],
  ['--help', [process.execPath, '--disable-warning=ExperimentalWarning', cli, '--help']],
  ['data-dir (cli graph, no adapters)', [process.execPath, '--disable-warning=ExperimentalWarning', cli, 'data-dir']],
  ['doctor', [process.execPath, '--disable-warning=ExperimentalWarning', cli, 'doctor']],
];
if (existsSync(compiledCli)) {
  for (const arg of ['-V', '--help', 'data-dir', 'doctor']) {
    cases.push([`compiled ${arg}`, [process.execPath, compiledCli, arg]]);
  }
}

console.log(`# ${runs} fresh processes each, median (min..max) wall ms; RSS = peak of the last sample`);
for (const [name, argv] of cases) {
  const xs: number[] = [];
  const samples: { wall: number; rssMB: number; status: number | null }[] = [];
  let rss = NaN;
  let bad = 0;
  for (let i = 0; i < runs; i += 1) {
    const s = sample(argv);
    samples.push(s);
    if (s.status !== 0) bad += 1;
    xs.push(s.wall);
    rss = s.rssMB;
  }
  entries.push({ name, samples });
  console.log(`${name.padEnd(36)} median ${median(xs).toFixed(0).padStart(5)} ms  (${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)})  peakRSS ${rss.toFixed(0)} MB  nonzeroExit=${bad}`);
}

mkdirSync(OUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = join(OUT_DIR, `startup-${stamp}.json`);
writeFileSync(outFile, JSON.stringify({ runs, repo, node: process.version, entries }, null, 2));
console.log(`results written to ${outFile}`);
