# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the major version is 0, a minor release may break compatibility; such changes are marked **breaking** below.

## [Unreleased]

## [0.2.0] - 2026-10-10

### Upgrading from 0.1.0

Install 0.2.0 over 0.1.0 with its `install.sh`; config, sessions and results are kept.

- **Config.** The first run rewrites `checker.config.json` with `"configVersion": 2` and keeps your old file next to it as `checker.config.json.v1.bak` (mode 600; an existing backup is never overwritten, a numbered one is added). One line on stderr names the backup. Running again changes nothing. Unknown keys are still rejected.
- **Database.** `checker.db` is upgraded in place to schema 3 (adds per-account batch times) by explicit per-version steps. Your rows are kept.
- **One way.** 0.1.0 refuses the new config keys and a database written by a newer schema. To go back: install 0.1.0 again, restore `checker.config.json.v1.bak` as `checker.config.json`, and restore a copy of `checker.db` made before upgrading. Copy `checker.db` first if you may want to roll back.
- **Menu.** `b` is now the one back key, and `b` can no longer be used as an account name.
- **Defaults unchanged.** `maxParallelAccounts` defaults to 1, so a run behaves as in 0.1.0 until you raise it. Threema and Matrix are disabled until you enable them.

### Added

- **Threema adapter** (official Threema Gateway `lookup/phone_hash`, plain HTTPS, no new dependency). Disabled by default. Setup guide: `docs/threema-setup.md`. Tested against stubbed HTTP responses only; **not verified live**. The lookup hash uses a public key, so the number is effectively disclosed to Threema.
- **Matrix adapter** (identity-service 3PID lookup, plain HTTPS, no new dependency; options `homeserver`, `identityServer`). Disabled by default. Setup guide: `docs/matrix-setup.md`. Tested against stubbed HTTP responses only; **not verified live**; coverage depends on identity servers that keep phone associations.
- **Parallel accounts.** New per-app setting `maxParallelAccounts` (default 1; Viber is always 1). A per-app dispatcher keeps one batch in flight per account, reserves the daily cap when a batch is sent, and records batch latency. With more than one account in flight, Ctrl-C gives batches 30 s to return before abandoning them (those numbers stay unknown and are charged to the cap).
- **Live run dashboard.** One row per account with state, done count, per-status counts and last batch time; rate, ETA and cooldown countdown in local time; the run log path. Plain and lines tiers carry the same facts without cursor movement. The run ends with a clearer summary (`Done in …`, `Accounts used: …`) and `o` reveals the report in Finder. Each check writes `check-<timestamp>.log` (mode 600, last 5 kept) in the data folder.
- `--plain` global flag and `PHONE_APP_CHECKER_PLAIN=1` force the plain tier (no colour, no cursor movement, no raw keys).
- **Menu.** The last 5 CSV files are remembered (mode 600, with "clear and stop remembering"), a CSV preview step before a run, an app checklist (Space ticks), an accounts view with reset and login actions, scrolling lists for short windows, text wrapped to the window in every tier, and a QR window-size check before login.
- `doctor --deep` loads every adapter module; the default `doctor` only resolves each adapter's package.
- `accounts` shows each account's batch time (average / last).
- `configVersion` and a config migration ladder; a database migration ladder with explicit per-version steps; fixtures of a 0.1.0 config and database; release verification check V20 upgrades a 0.1.0 home.
- Benchmark harness (`npm run bench`, `npm run bench:startup`) with a golden report hash, and `docs/performance.md`.
- `npm run build` compiles the TypeScript to `build/js/`.
- Documentation: `docs/performance.md`, `docs/adding-an-adapter.md`, release runbook in `CONTRIBUTING.md`, app-request issue template, `.github/release-template.md`.
- Project logo and brand assets in `docs/assets/` (SVG logo, light and dark lockups, one-colour marks, favicon and app icons, GitHub social preview) and a short usage guide in `docs/brand.md`.

### Changed

- **Breaking:** `checker.config.json` gains `configVersion` and is upgraded in place on first use (see Upgrading). A newer config file is refused untouched.
- **Breaking:** `checker.db` is schema 3. 0.1.0 cannot open it.
- **Breaking:** the report gains a status column each for `threema` and `matrix` (after `line`) plus their `*_checked_at` / `*_stale` columns, so anything that reads the report by column position must use the header names.
- **Breaking (menu):** prompts say `b = back`, and `b` is reserved: it can no longer be used as an account name.
- Faster: the scheduler no longer does quadratic work on large lists, the CSV is read in chunks and the report is streamed, prepared SQL statements are reused, and results are loaded once per app and run. A five-app 100 000-row `check` stage went from 158 s to 29 s; the report is identical to 0.1.0's except for the six new threema/matrix columns (this Mac; see `docs/performance.md`).
- Faster start: `doctor` no longer imports adapter libraries by default, non-English catalogs and `libphonenumber-js` load lazily, and the macOS archive runs precompiled JavaScript (cold `doctor` about 480 ms to about 70 ms).
- Progress output is drawn on a 1 Hz tick instead of on every event.
- User-visible times (rest until, resume at, ETA) are shown in local time.
- The macOS archive's post-install self-check runs `doctor --deep`.
- Icons are single-width (`✔`, `○`, `●`, `◷`) with ASCII fallbacks; no emoji in the menu.

### Removed

- The five-app literals in the release scripts and tests: the app list now comes from `APPS`.

### Fixed

- Menu QR gate read the window size once, so pressing Enter after enlarging the window checked the old size; the pre-login QR fit check also sized the code as plain output.
- Release verification V20 compared the database version against a literal; it now reads the version from the bundle.
- Dashboard rows wider than the window and column drift between header and rows.

### Security

- No new runtime dependency. Threema and Matrix requests never log URLs, secrets, tokens or passwords, and their credentials are stored mode 600.
- The config backup is created exclusively (no overwrite, no symlink following) with mode 600.
- `npm audit --omit=dev` reports 0 vulnerabilities.

## [0.1.0] - 2026-10-09

First public release.

### Added

- `phone-app-checker` CLI with the commands `login`, `check`, `report`, `accounts`, `account-reset` and `doctor`.
- Adapters for Telegram (mtcute), WhatsApp (Baileys v7), Zalo (zca-js), Viber (Android emulator / rooted phone via adb and Viber's own contact sync) and LINE (linejs).
- CSV input with phone-column auto-detection, delimiter and encoding sniffing, E.164 normalisation and de-duplication; CSV report with per-app status, `*_checked_at` and `*_stale` columns.
- Scheduler with batching, per-account daily caps, pacing with jitter, rate-limit and error cooldowns, resumable runs, Ctrl-C handling and an `INCOMPLETE` banner; SQLite result store with a result cache (`maxAgeDays`).
- Interactive menu with colours, arrow-key selection, progress bar and scannable terminal QR codes; menu languages English, Vietnamese, Bahasa Indonesia, Bahasa Melayu, Korean and Simplified Chinese (the last four are unreviewed first drafts).
- Privacy hardening: masked phone numbers in logs, no profile data stored (Telegram peer cache disabled and scrubbed), private file modes, refusal of cloud-synced folders, spreadsheet-formula and terminal-escape neutralisation.
- macOS Apple Silicon portable archive (bundled, pinned Node.js; `install.sh` / `uninstall.sh`; clean-room verification checks V1-V19) with `LICENSE` and `THIRD_PARTY_LICENSES.md`.
- Documentation: README, English and Vietnamese macOS install guides, per-app setup guides, reference, architecture, responsible-use notice.
- GitHub project files: CI, release workflow, Dependabot, issue and pull request templates, security policy, code of conduct.

### Known limitations

- Only WhatsApp has been exercised against the live service (one account, a few lookups). Telegram, Zalo, Viber and LINE are verified with test doubles only.
- The release archive is Apple Silicon only, not code-signed or notarised, and was not run on macOS 13.5 or Intel Macs.
- Licensed GPL-3.0-or-later because the bundled `baileys` dependency tree includes the GPL-3.0 package `libsignal`.

[Unreleased]: https://github.com/QuocHuannn/phone-app-checker/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/QuocHuannn/phone-app-checker/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/QuocHuannn/phone-app-checker/releases/tag/v0.1.0
