# Architecture

phone-app-checker is a single-process Node.js CLI written in TypeScript. From a source checkout Node >= 22.18 runs the `.ts` sources directly (type stripping) and `tsc --noEmit` is the type check. The macOS release archive runs the same code **precompiled**: `npm run build` compiles `src/` and `bin/` to JavaScript under `build/js/`, and the archive ships only that (no `.ts`). Package-relative files (`package.json`, `checker.config.example.json`, `BUILD-INFO.json`) resolve from both trees.

## Overview

```mermaid
flowchart LR
    CSV[/"Input CSV"/] --> P["csv.ts + phone.ts<br/>detect column, normalise to E.164,<br/>de-duplicate"]
    P --> S["scheduler.ts<br/>per-app dispatcher: batching, pacing,<br/>daily caps, cooldowns, resume, Ctrl-C"]
    ST[("store.ts<br/>SQLite schema 3: results, accounts,<br/>failed_checks")] <--> S
    S -->|"Adapter.open(ctx).check(batch)"| A

    subgraph A["src/adapters (one per app)"]
        direction TB
        TG["telegram.ts<br/>mtcute, contacts.importContacts"]
        WA["whatsapp.ts<br/>Baileys, onWhatsApp"]
        ZA["zalo.ts<br/>zca-js, findUser (+84 only)"]
        LN["line.ts<br/>linejs, findContactByPhoneV3"]
        VB["viber.ts<br/>adb + Viber's own contact sync"]
        TH["threema.ts<br/>Gateway lookup/phone_hash (HTTPS)"]
        MX["matrix.ts<br/>identity-server 3PID lookup (HTTPS)"]

    A -->|"yes / not_found / unknown,<br/>RateLimited, AccountBanned"| S
    ST --> R["report.ts<br/>report.csv + terminal summary"]
    R --> OUT[/"report.csv"/]
    CLI["cli.ts / menu.ts<br/>commands and interactive menu"] --> P
    CLI --> L["login flows<br/>(QR / pairing code / OTP)"]
    L --> SES[("data/sessions/&lt;app&gt;/&lt;account&gt;<br/>mode 700, files 600")]
    SES --> A
```

## Components

| Path | Responsibility |
| --- | --- |
| `src/cli.ts`, `src/menu.ts`, `src/screens.ts`, `src/select.ts`, `src/ui.ts`, `src/progress.ts`, `src/recent.ts` | [commander](https://github.com/tj/commander.js) command tree, the interactive menu (recent files, CSV preview, app checklist, QR window check), the terminal UI (colour, arrow-key selection, the live run dashboard) and its plain tier. Everything degrades to plain text when stdout is not a terminal or `--plain` / `PHONE_APP_CHECKER_PLAIN` is set. |
| `src/csv.ts`, `src/phone.ts` | Delimiter / encoding sniffing, phone column detection, normalisation to E.164 with [libphonenumber-js](https://gitlab.com/catamphetamine/libphonenumber-js), de-duplication. |
| `src/scheduler.ts` | One dispatcher per app (see [Process model](#process-model-and-dispatcher-invariants)). Turns "numbers x apps x accounts" into batches. Enforces `batchSize`, `dailyCap`, `minIntervalMs` + jitter, `maxParallelAccounts`, rate-limit and error cooldowns, drops an account after repeated failures, parks a batch that keeps failing, resumes after an interruption, records batch latency, and handles Ctrl-C. |
| `src/store.ts` | SQLite (`node:sqlite`) with schema version 3 and an explicit per-version migration ladder: `results(e164, app, status, checked_at)`, `accounts` (cooldown, disabled reason, daily usage, batch latency), `failed_checks`. Prepared statements are reused. Created with mode 600; symlinks and foreign owners are refused. |
| `src/adapters/*.ts` | One adapter per app behind the interface in `src/types.ts` (`Adapter.login`, `Adapter.open`, `Session.check`). Adapters are imported dynamically, so an unofficial client that breaks does not take the other apps or `report` down. Errors are classified as `RateLimited` (back off) or `AccountBanned` (needs a human); everything else is a temporary error. `APPS` in `src/types.ts` is the single source of truth for the app list. How to add one: [adding-an-adapter.md](adding-an-adapter.md). |
| `src/report.ts` | Builds `report.csv` (status and `*_checked_at` / `*_stale` columns per app) by streaming rows to a private temp file, and the terminal summary; protects against overwriting the input or foreign files, and neutralises spreadsheet formulas. |
| `src/home.ts`, `src/paths.ts`, `src/lock.ts`, `src/private-file.ts` | App home and data directory resolution, refusal of unsafe or cloud-synced folders, the single-run lock and the lifecycle barrier that keeps install/uninstall from running next to a command, private file modes. |
| `src/doctor.ts` | Offline readiness checks (runtime, config, data dir, each adapter's prerequisites). By default it only resolves each adapter's package; `--deep` also loads every adapter module. It never contacts a platform. |
| `src/i18n/*` | Menu, login and run texts: English (source), Vietnamese, and first-draft Indonesian, Malay, Korean, Chinese. Non-English catalogs load lazily. |
| `release/`, `scripts/build-release.sh`, `scripts/verify-release.sh`, `tsconfig.build.json` | macOS arm64 portable archive: pinned official Node.js, precompiled JavaScript, production `node_modules` built by that Node, `install.sh` / `uninstall.sh`, and a clean-room verification (V1-V20). |

## How each app is checked

| App | Mechanism | Sends anything to the person? |
| --- | --- | --- |
| Telegram | Logs in as a user account (MTProto, via mtcute) and imports the numbers as temporary contacts (`contacts.importContacts`); only the mapping `number -> exists` is used. Imported contacts are removed after each batch. The session database stores credentials only, not profiles. | No |
| WhatsApp | Linked device of a dedicated account (Baileys); asks WhatsApp's contact-discovery service (`onWhatsApp`) which numbers are registered. | No |
| Zalo | Logged-in session (zca-js); `findUser` by phone number. Error 216 is treated as `not_found` (no account **or** hidden from phone search). Vietnamese numbers only. | No |
| LINE | Logged-in secondary device (linejs); read-only `findContactByPhoneV3`. Meaningful only where LINE enables phone search. | No |
| Viber | No lookup API exists. Injects contacts on an Android emulator or rooted phone under a dedicated account, lets Viber sync them, reads which ones Viber marked as registered from Viber's own database with queries **you** supply, then deletes the contacts. | No |
| Threema | Official Threema Gateway: `GET lookup/phone_hash/<HMAC-SHA256(public key, number)>` with your Gateway ID and secret. Matches only people who linked a phone number. The key is public, so the number is effectively disclosed to Threema. Not verified live. | No |
| Matrix | Matrix identity-service API: log in once to obtain an identity-server token, then `POST /_matrix/identity/v2/lookup` with salted SHA-256 hashes of the numbers. Matches only people who linked a phone number to an identity server. Not verified live. | No |

## Process model and dispatcher invariants

`check` runs in one process. For every app the scheduler starts one dispatcher. A dispatcher owns a queue of numbers and a set of accounts (the directories under `data/sessions/<app>/`) and keeps these invariants:

- **One batch in flight per account**, and at most `maxParallelAccounts` per app (default 1; Viber is always 1 because there is one device). With 1 the behaviour is the one of 0.1.0.
- **Pacing is per account.** After a batch an account waits `minIntervalMs + random(0..jitterMs)` before the next one, whatever the other accounts do.
- **The daily cap is reserved at dispatch and settled at commit.** A batch that succeeds is charged its length; a throttle or ban is charged only the answers it returned; a batch abandoned on Ctrl-C is charged in full. The cap can therefore never be exceeded with several batches in flight.
- **One transaction per completed batch** on one store connection, with SQLite `synchronous` left at FULL. A crash loses at most the batches in flight.
- **Results are loaded once per app and run** and shared with the pending-number selection and the report.
- **A failed lookup never overwrites an earlier `yes` / `not_found`.**
- **Ctrl-C.** The first interrupt stops dispatching. With one account in flight the batch is waited for however long it takes (0.1.0 contract); with more, batches get `closeTimeoutMs` (30 s) to return and commit and are otherwise abandoned (numbers stay unknown). A second interrupt quits at once. Either way the report is written and the exit code is 130.
- **Progress is event-driven.** The dispatcher emits `ProgressEvent`s with one row per account (`working`, `waiting`, `cooldown`, `disabled`, `done`, `waitingUntil`, per-status counts, done count, last batch time). The dashboard renders them at most once a second; the plain and lines tiers print the same facts as text.

Why not group commits: durability was kept as in 0.1.0 on purpose, and the 100k-row benchmark shows the transaction time is not the bottleneck any more ([performance.md](performance.md)).

## Config and database migrations

Both are one-way ladders with explicit per-version steps, so later versions add a step instead of an ad-hoc change.

- **Config.** `configVersion` (absent means 1, the 0.1.0 format; current is 2). `loadConfig` migrates in memory, validates, then writes a mode-600 backup (`checker.config.json.v<N>.bak`, created exclusively, never overwritten) and replaces the file atomically; it prints one line naming the backup. A file with a newer version is refused untouched. Unknown keys are still rejected. New optional keys with defaults need no step.
- **Database.** `src/store.ts` `migrate()` runs `version < 1`, `< 2`, `< 3` blocks, each in one transaction, and sets `PRAGMA user_version`. Schema 2 added `failed_checks`; schema 3 adds `last_batch_ms`, `avg_batch_ms` and `batches_done` to `accounts` by `ALTER`. A database from a newer build is refused before anything is changed.
- **Tested with fixtures.** `tests/fixtures/v0.1.0/` holds a synthetic 0.1.0 config and a generator for the 0.1.0 database; the unit tests and release check V20 upgrade them.

## Design decisions

- **Fail closed.** Missing credentials, an unknown schema, an unsafe folder or a stale lock stop the run with a message instead of guessing.
- **Resumable by default.** Results are committed after every batch; a re-run asks only for what is missing or older than `maxAgeDays`. A later failed lookup never overwrites an earlier `yes` / `not_found`, and the report marks such cells stale.
- **Privacy by construction.** No names, avatars, ids or profile data are read or stored. Logs mask numbers (`+8490****567`), including inside URLs and paths.
- **Honest outputs.** Every report states per app how many numbers were needed, attempted and conclusive, and an `INCOMPLETE` banner is printed last when some are not.
- **No fake mode at runtime.** Tests substitute adapters only through the `loadAdapter` seam of `createProgram`, and adapter tests replace only the third-party client (or `adb`) with test doubles.

## Release pipeline

`scripts/build-release.sh` downloads the pinned Node.js tarball, verifies its SHA-256 and Apple signature, compiles the TypeScript with that Node, runs `npm ci --omit=dev` with it (deployment target macOS 13.5), then gates the stage: load gate (every adapter in `APPS` imports from the compiled `.js`), architecture gate (every native file is arm64), minimum-OS gate (every Mach-O `minos` <= 13.5), `npm audit --omit=dev`, hygiene gate (no config, CSV, databases, maps, `.ts` sources). `scripts/verify-release.sh` unpacks the finished archive in a temporary `HOME` with an empty environment and runs install, `doctor --deep`, an offline `report`, reinstall, an upgrade from a 0.1.0 home (config and database migrate, backup is mode 600, second run is a no-op) and uninstall (checks V1-V20). The archive ships `LICENSE`, `THIRD_PARTY_LICENSES.md` and the bundled Node.js licence. The tag workflow and the maintainer runbook are in [CONTRIBUTING.md](../CONTRIBUTING.md#releasing-maintainers).
