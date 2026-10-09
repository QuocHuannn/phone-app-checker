// Offline benchmark driver: every stage runs in its own process so peak RSS is measured per
// stage (macOS: /usr/bin/time -l; elsewhere: resourceUsage of the child). Results go to stdout as
// a table and to bench/out/<timestamp>.json. Timings are printed, never asserted; the only gate
// is the report sha256 for the committed golden configuration (see bench/golden.json).
//   node --disable-warning=ExperimentalWarning bench/run.ts [--rows N] [--seed S] [--apps list]
//       [--accounts K] [--latency-ms L] [--batch B] [--stages a,b,c] [--repo path] [--work path]
//       [--golden path]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const BENCH_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(join(BENCH_DIR, '..'));
const STAGE = join(BENCH_DIR, 'lib', 'stage.ts');
const OUT_DIR = join(BENCH_DIR, 'out');
const DEFAULT_GOLDEN = join(BENCH_DIR, 'golden.json');

interface Options {
  rows: number;
  seed: number;
  apps: string[];
  accounts: number;
  latencyMs: number;
  batch: number;
  stages: string[];
  repo: string;
  work: string;
  golden: string;
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = { rows: 20_000, seed: 1, accounts: 2, latencyMs: 0, batch: 10, repo: REPO, golden: DEFAULT_GOLDEN };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--rows': options.rows = Number(value); i += 1; break;
      case '--seed': options.seed = Number(value); i += 1; break;
      case '--apps': options.apps = (value as string).split(','); i += 1; break;
      case '--accounts': options.accounts = Number(value); i += 1; break;
      case '--latency-ms': options.latencyMs = Number(value); i += 1; break;
      case '--batch': options.batch = Number(value); i += 1; break;
      case '--stages': options.stages = (value as string).split(','); i += 1; break;
      case '--repo': options.repo = resolve(value as string); i += 1; break;
      case '--work': options.work = resolve(value as string); i += 1; break;
      case '--golden': options.golden = resolve(value as string); i += 1; break;
      default: throw new Error(`unknown argument ${flag}`);
    }
  }
  options.apps ??= ['telegram', 'whatsapp', 'zalo', 'viber', 'line'];
  options.stages ??= ['parse', 'normalize', 'commits', 'check', 'report'];
  options.work ??= mkdtempSync(join(tmpdir(), 'pac-bench-'));
  return options as Options;
}

interface StageResult {
  stage: string;
  [key: string]: unknown;
}

/** Run one stage in a fresh process; returns the stage JSON plus wall time and peak RSS. */
function runStage(options: Options, stage: string, extra: string[]): StageResult & { wallMs: number; peakRssMB?: number; exit: number | null } {
  const argv = [
    process.execPath,
    '--disable-warning=ExperimentalWarning',
    STAGE,
    '--repo', options.repo,
    '--work', options.work,
    '--stage', stage,
    '--rows', String(options.rows),
    '--seed', String(options.seed),
    '--apps', options.apps.join(','),
    '--accounts', String(options.accounts),
    '--latency-ms', String(options.latencyMs),
    '--batch', String(options.batch),
    ...extra,
  ];
  const useTime = process.platform === 'darwin';
  const t0 = process.hrtime.bigint();
  const result = spawnSync(useTime ? '/usr/bin/time' : argv[0]!, useTime ? ['-l', ...argv] : argv.slice(1), {
    env: { ...process.env, HOME: join(options.work, 'home') },
    encoding: 'utf8',
    maxBuffer: 256 << 20,
    timeout: 3_600_000,
  });
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const err = result.stderr ?? '';
  const rssMatch = /(\d+)\s+maximum resident set size/.exec(err);
  const jsonLine = (result.stdout ?? '').trim().split('\n').filter(Boolean).pop();
  const payload = jsonLine !== undefined ? (JSON.parse(jsonLine) as StageResult) : { stage, error: `no output (exit ${result.status})`, stderr: err.split('\n').slice(0, 5).join(' | ') };
  return {
    ...payload,
    wallMs: Number(wallMs.toFixed(0)),
    peakRssMB: rssMatch ? Number((Number(rssMatch[1]) / 1048576).toFixed(0)) : undefined,
    exit: result.status,
  };
}

interface Golden {
  params: { seed: number; rows: number; latencyMs: number; accounts: number; apps: string[] };
  reportSha256: string;
}

const args = parseArgs(process.argv.slice(2));
// Refuse before anything is created: a work dir inside a checkout would sit next to real data.
const repoRoot = realpathSync(args.repo);
const workReal = existsSync(args.work) ? realpathSync(args.work) : resolve(args.work);
if (workReal === repoRoot || workReal.startsWith(repoRoot + sep)) {
  throw new Error(`refusing to run the benchmark with a work directory inside the repo: ${args.work}`);
}
mkdirSync(args.work, { recursive: true });
const results: (StageResult & { wallMs: number; peakRssMB?: number; exit: number | null })[] = [];
for (const stage of args.stages) {
  const r = runStage(args, stage, []);
  results.push(r);
  const rss = r.peakRssMB === undefined ? '?' : `${r.peakRssMB} MB`;
  const sha = typeof r.reportSha256 === 'string' ? ` sha256 ${String(r.reportSha256).slice(0, 16)}…` : '';
  const error = r.error ? ` ERROR ${String(r.error).slice(0, 120)}` : '';
  const simMin = typeof r.simulatedMin === 'number' ? ` sim ${r.simulatedMin} min` : '';
  console.log(`${stage.padEnd(10)} wall ${String(r.wallMs).padStart(7)} ms  rss ${rss.padStart(7)}${sha}${simMin}${error}`);
}

// Golden guard: with the committed parameters the report bytes must be exactly what they were.
let goldenStatus = 'skipped';
const goldenPath = args.golden;
if (existsSync(goldenPath)) {
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as Golden;
  const p = golden.params;
  const sameRun =
    p.rows === args.rows && p.seed === args.seed && p.latencyMs === args.latencyMs &&
    p.accounts === args.accounts && p.apps.join(',') === args.apps.join(',');
  if (sameRun) {
    const check = results.find((r) => r.stage === 'check');
    if (check?.reportSha256 === golden.reportSha256) {
      goldenStatus = 'match';
      console.log(`golden sha256 ${golden.reportSha256.slice(0, 16)}… matches`);
    } else {
      goldenStatus = `MISMATCH expected ${golden.reportSha256} got ${check?.reportSha256 ?? 'none'}`;
      console.error(`golden sha256 mismatch: expected ${golden.reportSha256}, got ${check?.reportSha256 ?? 'none'}`);
    }
  } else {
    goldenStatus = 'skipped (different parameters)';
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outFile = join(OUT_DIR, `bench-${stamp}.json`);
writeFileSync(outFile, JSON.stringify({ options: { ...args, work: undefined }, node: process.version, results, golden: goldenStatus }, null, 2));
console.log(`results written to ${outFile}`);

if (goldenStatus.startsWith('MISMATCH')) process.exit(1);
if (results.some((r) => r.exit !== 0 || r.error !== undefined)) process.exit(1);
