# Performance

What 0.2.0 changed in speed and memory, how it was measured, and how to measure it yourself. Every number here comes from the offline bench harness in [`bench/`](../bench) with **fake adapters**: no messaging service was contacted. Real platform latency and rate limits are not measured and not known (see [Not measured](#not-measured)).

## Machine and method

| Item | Value |
| --- | --- |
| Machine | Apple M2 Max, arm64 |
| OS | macOS 27.0 |
| Node.js | v24.14.0 (source runs); the macOS archive runs its pinned Node 24.21.0 |
| Date | 2026-10-10 |
| Baseline | the 0.1.0 code at commit `f8600ac` (the base of the 0.2.0 branch) |
| Peak memory | `/usr/bin/time -l` per stage process (maximum resident set size) |
| Timing | wall clock of one run per stage; the startup table is the median of 9 fresh processes |

Each bench stage runs in its own process with a temporary `HOME` and a work folder under the system temp directory. The harness refuses a work folder inside a repository checkout, so it can never touch the repo `data/` or your real app home. Timings are printed, never asserted. The only gate is the report hash for the committed golden configuration (`bench/golden.json`): if the bytes of the report change for the same seed, the run exits 1.

Run it yourself:

```sh
npm run bench                                   # golden configuration: 20 000 rows, 5 apps, seed 1; checks the report sha256
npm run bench -- --rows 100000                  # the 100k tables below
npm run bench -- --stages parse --rows 300000   # one stage
npm run bench -- --stages sim --accounts 8 --latency-ms 60000 --apps telegram --rows 5000 --parallel 4
npm run bench:startup                           # cold start of the TypeScript entry and, if built, the compiled bundle
npm run build && npm run bench:startup          # include the compiled tree
```

Stages: `parse`, `normalize`, `commits`, `check`, `report`, and `sim` (a virtual-clock simulation of the shipped pacing). Options: `--rows`, `--seed`, `--apps`, `--accounts`, `--latency-ms`, `--batch`, `--parallel`, `--stages`. Results also go to `bench/out/<timestamp>.json` (git-ignored).

## Large lists: the `check` pipeline

Five apps, 100 000 rows, seed 1, fake adapters with zero latency:

| Measure | 0.1.0 | 0.2.0 | Change |
| --- | --- | --- | --- |
| `check` stage, wall | 158.1 s | 28.8 s | **5.5x faster** |
| `check` stage, peak memory | 823 MB | 458 MB | -44 % |
| `parse` stage, wall / peak memory | 783 ms / 298 MB | 773 ms / 209 MB | same speed, -30 % memory |
| `report` stage, wall / peak memory | 1 886 ms / 640 MB | 1 853 ms / 492 MB | same speed, -23 % memory |
| Results loaded per app and run | 3 | 1 | one `allResults` read per app |
| SQLite transactions (one per completed batch) | 205 318 | 205 318 | same durability model |
| Time spent in transactions | 21.1 s | 16.4 s | -22 % (prepared statements reused) |
| Report SHA-256 | `fae76d86...` | `fae76d86...` | **identical bytes** |

300 000-row parse: 435 MB peak before, 352 MB after (-19 %), about 2.1 s both.

Where the time went: the 0.1.0 scheduler re-compacted its whole pending list after every batch, which is quadratic in the list size. 0.2.0 compacts only the batch prefix. The CSV is now read in 256 KB chunks and fed record by record into the column detector, and the report is streamed to its temporary file through 256 KB buffered writes (atomic rename, mode 600 and fsync unchanged). The database keeps `PRAGMA synchronous` at its default (FULL) and one transaction per completed batch, so a crash still loses at most the batch in flight.

The 20 000-row golden run (seed 1, 2 accounts, five apps, zero latency) produces the report hash `4ddd117eaf8f1986c233c872333377ddb680ee9ec10e0a754b56f7aaab3b3453` on both the 0.1.0 code and 0.2.0. That is the guard that the speed-up did not change any result.

## Start-up

Median of 9 fresh processes, each in a temporary `HOME` and working directory:

| Command | 0.1.0 (TS) | 0.2.0 from source (TS) | 0.2.0 compiled (`build/js`, the macOS archive) |
| --- | --- | --- | --- |
| `--version` | 109 ms | 90 ms | 50 ms |
| `--help` | 108 ms | 90 ms | 50 ms |
| `data-dir` | 108 ms | 101 ms | 60 ms |
| `doctor` | 482 ms | 107 ms | 66 ms |

What changed: `doctor` no longer imports the adapter libraries (it only checks that each package resolves), `libphonenumber-js` and the non-English message catalogs load on first use, and the archive runs precompiled JavaScript instead of stripping types at start. `doctor --deep` still loads every adapter and takes about 440 ms compiled (one sample): that is the old cost, now opt-in.

Re-measure after `npm run build` with `npm run bench:startup`.

## Parallel accounts

`maxParallelAccounts` (default 1) lets several accounts of one app have a batch in flight at once. The default keeps the 0.1.0 behaviour exactly (the golden report hash is unchanged). The simulation below uses the shipped Telegram pacing on a virtual clock: 8 accounts, 5 000 rows, 476 batches. The batch latencies are **made up** to show the shape; they are not measurements of Telegram.

| Batch latency | K = 1 | K = 2 | K = 4 | K = 8 |
| --- | --- | --- | --- | --- |
| 2 s | 149.6 min | 149.5 | 149.5 | 149.5 |
| 60 s | 476 min | 238 | 207.5 | 207.5 |

- When a batch is quick (2 s) the run is bound by the pacing pause between batches on each account, so more parallel accounts gain nothing.
- When a batch is slow (60 s), K = 2 halves the time and K = 4 or more reaches the pacing floor (about 210 min).
- So parallelism pays only when the batch time is large compared with the pacing pause. The `accounts` command shows each account's average and last batch time (stored per account from 0.2.0 on): measure first, then raise `maxParallelAccounts` one step at a time.
- More simultaneous sessions mean more ban exposure: see [responsible-use.md](responsible-use.md).

Invariants proven by tests on a virtual clock: one batch in flight per account, per-account pacing, the daily cap reserved when a batch is dispatched (never exceeded with batches in flight), Viber forced to one, and Ctrl-C. With K = 1 Ctrl-C waits for the batch in flight however long it takes (as in 0.1.0); with K > 1 batches get 30 s to return and commit, and any that do not are abandoned, their numbers stay `unknown` and are charged to the cap, so a rerun repeats at most K batches.

## Not measured

- Real latency, rate limits and ban thresholds of any platform. Run a small pilot and read `phone-app-checker accounts`.
- Intel Macs, Linux and macOS 13.5. The compiled-archive start-up numbers are from the M2 Max only.
- Threema and Matrix (stubbed HTTP only).
- Other machines will differ in absolute numbers; compare ratios, and run `npm run bench` on your own machine.
