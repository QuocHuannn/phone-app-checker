# phone-app-checker reference

Detailed reference for the CLI. The [project README](../README.md) has the overview and quick start; this page documents behaviour, configuration, data handling and limits in depth.

Input: a CSV of phone numbers of people who agreed to be checked. Output: `report.csv`, one row per number, one status column per app (Telegram, WhatsApp, Zalo, Viber, LINE), plus a summary table in the terminal.

Everything runs on your machine with **dedicated, disposable SIM accounts** and open-source unofficial clients. There is no vendor API and nothing is sent to a third party except the lookups the apps themselves make.

> **Read this first.** Every adapter drives an app in a way its terms of service do not allow. Checking accounts can be throttled, restricted or banned (you accept this risk by using the tool). Use dedicated SIMs/accounts you can afford to lose, never a personal or business-critical number. Only check numbers of people who agreed to it: the tool does not check consent for you. See [responsible-use.md](responsible-use.md).

## Download for macOS (no Node.js needed)

Apple Silicon Macs (macOS 13.5 or newer) can run a prebuilt archive, `phone-app-checker-<version>-macos-arm64.tar.gz`, that carries its own Node.js runtime and dependencies. Verify the `.sha256`, unpack, run `bash install.sh`, open a new Terminal and type `phone-app-checker` with no arguments: a menu (English by default; press `L` to switch to Vietnamese, Indonesian, Malay, Korean or Simplified Chinese) walks through login, checking a CSV, accounts, the latest report and `doctor` (see [Interactive menu](#interactive-menu)); the commands `phone-app-checker doctor` / `login` / `check` work as before. Step-by-step guide for non-developers: [install-macos.md](install-macos.md) (Vietnamese: [install-macos.vi.md](install-macos.vi.md)). Data, config and sessions live in `~/Library/Application Support/phone-app-checker`, never inside the program folder; keep customer CSVs in a dedicated local, non-synced folder (not `Documents`/`Desktop`/iCloud). The archive is built from this repository with `npm run release:build` (see [Development](#development)); the live-account checks listed under [What is verified, and what is not](#what-is-verified-and-what-is-not) still apply. The 13.5 floor is set by the bundled Node.js; the build and `release:verify` check every shipped Mach-O's minimum-OS load command, which is necessary but **not** a run on macOS 13.5 (only macOS 27 has run it).

## What it never does

No messages, calls, friend requests or group invites. It does not read or store names, avatars, user ids, last-seen or any profile data (Telegram's client library would cache the profiles it receives; the adapter disables that cache and scrubs sessions written by older versions). Logs show phone numbers masked (`+8490****567`), also inside URLs and file paths. The only place full numbers are stored is the local SQLite file and the report you asked for.

## Status values

| Value | Meaning |
| --- | --- |
| `yes` | The app answered that the number has an account. |
| `not_found` | The app did not return an account for the number. **Not proof the person has no account**: users can hide themselves from search by phone number (Telegram, Zalo, LINE), and Viber's answer depends on contact sync. |
| `unknown` | Not checked yet, or the check failed / was throttled. Re-run `check`; unknown results are retried. |
| `skipped` | App disabled or not selected (`--apps`), or the number is outside the app's scope (Zalo only checks `+84`). |
| `invalid` | The cell is not a valid phone number (after normalisation with `defaultRegion`). Written for every app column. |

Report columns: `input` (your original cell), `e164`, `country`, `telegram`, `whatsapp`, `zalo`, `viber`, `line`, `last_checked_at` (the newest time of **any** stored result for that number, an `unknown` attempt included, ISO-8601 UTC; empty for `invalid` rows; it says nothing about an individual app), then ten columns appended at the end: `<app>_checked_at` for the five apps (when that app's `yes`/`not_found` itself was obtained; empty for `unknown`/`skipped`/`invalid`) and `<app>_stale` for the five apps (`yes` when that `yes`/`not_found` is older than the max age or dated in the future, `no` when current, empty otherwise). A `yes` or `not_found` is an observation at that time, not proof of identity or of a currently active account. A report written with the older header is still recognised as this tool's own and overwritten without `--force`.

## Requirements

- Node.js **>= 22.18** (the CLI runs the TypeScript sources directly; `node:sqlite` is built in). Tested on Node 24.14 and 22.18.0.
- npm (the LINE client comes from the JSR registry; `.npmrc` already points `@jsr` at `https://npm.jsr.io`). `package.json` `overrides` pins `thrift` (used by the LINE client) to `^0.25.0` because 0.20.0 has published high-severity advisories; `npm audit --omit=dev` is clean with it.
- Per app, see [Per-app prerequisites](#per-app-prerequisites-and-limits).
- **Using the macOS download instead?** No Node.js or npm is needed: see [Download for macOS](#download-for-macos-no-nodejs-needed). The two requirements above apply only to running from source.

## Install

```sh
git clone https://github.com/QuocHuannn/phone-app-checker.git phone-app-checker && cd phone-app-checker
npm install
cp checker.config.example.json checker.config.json     # then edit; checker.config.json is git-ignored
```

Run the CLI as any of:

```sh
npm run cli -- <command>          # used in all examples below
./bin/phone-app-checker.js <command>
npm link && phone-app-checker <command>
```

`npm run cli -- --help` and `npm run cli -- <command> --help` list every option.

## Interactive menu

Run `phone-app-checker` (or `npm run cli`) **with no arguments in a terminal** to open a numbered menu, so nobody has to remember subcommands: 1 check a CSV (drag the file from Finder into the window; quoted, backslash-escaped, `file://` and `~` paths are understood; choose apps; the report defaults to `report.csv` next to the CSV and asks before overwriting), 2 log an account in (lists the five apps with their status, then asks how: WhatsApp = scan a QR code *or* a pairing code with the account's phone number; Telegram = QR *or* phone number + login code, after asking once for the `api_id` / `api_hash` and saving them in the config; see [Login screens](#login-screens-qr-codes-pairing-codes-telegram-credentials)), 3 `accounts`, 4 rebuild the latest report (`report`), 5 `doctor` (offline readiness only), 6 short warnings (consent, `not_found` may mean privacy-hidden, LINE only in HK/JP/KR/TW/TH, Zalo Vietnam only, ban risk), L change the language, 0 quit. Each action runs the ordinary command, so locks and the install/uninstall exclusion are taken and released per action; a command that fails shows its message, says that nothing was saved, and the menu stays open. Ctrl+C or Ctrl+D quits cleanly.

**Language.** The menu is in **English by default**, whatever the system locale. Every menu screen has an `L` line (`L. Language / Ngôn ngữ / Bahasa / 언어 / 语言: English`); `L` lists the languages, each in its own script, and switches at once:

| Code | Language | Status |
| --- | --- | --- |
| `en` | English (default) | source text |
| `vi` | Tiếng Việt | the original menu text |
| `id` | Bahasa Indonesia | first-draft, machine-quality; needs native-speaker review |
| `ms` | Bahasa Melayu | first-draft, machine-quality; needs native-speaker review |
| `ko` | 한국어 | first-draft, machine-quality; needs native-speaker review |
| `zh` | 简体中文 | first-draft, machine-quality; needs native-speaker review |

Menu prompts, guidance and warnings, and the screens of `login` (QR/pairing-code instructions, Telegram prompts) are translated; the output of `doctor`, `check` and the other commands stays English. `login` takes the language from the menu, from `--lang <code>` (hidden flag of the `login` command), then `PHONE_APP_CHECKER_LANG`, then the saved choice, then English. Precedence for the menu itself: `phone-app-checker --lang <code>` (hidden flag, opens the menu in that language; only valid on its own) > environment variable `PHONE_APP_CHECKER_LANG=<code>` > the saved choice > English. A set but unsupported flag or variable value (anything other than the six codes above, any case) gives English, silently; an empty one counts as unset. The saved choice is the file `menu-language` (just the code, mode 600, written atomically) in the app home (`~/Library/Application Support/phone-app-checker`), validated like the config before it is written; it is removed by `uninstall.sh --purge-data` together with the rest of that folder. A language file that is missing, a symlink, oversized, owned by someone else, or readable/writable by group or others is ignored (English), and a failed save only means the choice lasts for that session (the menu says so and carries on). In a source checkout (no `PHONE_APP_CHECKER_HOME`) there is no private app home, so a switch lasts for the session only; use `--lang` or the variable there. Messages live in `src/i18n/`: one typed catalog per language, checked at compile time (`satisfies Catalog`) and by `tests/i18n.test.ts` (identical keys, identical placeholders, no empty strings, no control characters). Menu lines are never padded with spaces for alignment, because Korean and Chinese characters have no fixed width. **Translations other than English and Vietnamese are first drafts and have not been reviewed by native speakers.**

The menu opens only when there are no arguments **and** both stdin and stdout are terminals. With any subcommand, or when piped / run from a script, behaviour is unchanged (no arguments and no terminal still prints the usage and exits 1; the menu never waits for input there).

### Terminal UI (colours, arrow keys, progress bar)

On a **real terminal** (stdout is a TTY, `TERM` is set and not `dumb`, `NO_COLOR` is not set) the menu and the login screens use a small internal UI layer (`src/ui.ts`, `src/select.ts`, `src/progress.ts`, `src/screens.ts`). Everywhere else (pipes, files, cron, `NO_COLOR`, `TERM=dumb`, an unset `TERM`) nothing here writes a single ANSI escape sequence, icons are plain ASCII and the output is byte-for-byte what it was before.

- **Banner.** A box with the app name, the version and a status strip of accounts ready per app, for example `⬜ telegram – · ✅ whatsapp 1 · ⬜ zalo – · ⬜ viber – · ⬜ line –`. Boxes have a left bar only, no right edge, so Hangul / CJK / emoji can never push a border out of line; long text is wrapped to the window and long paths are cut from the left (`…/Customers/report.csv`).
- **Arrow-key menus.** `↑` / `↓` + Enter, a row's own key (`1`-`6`, `L`, `0`) picks it at once, `q` / Esc quit (or go back in a sub-list), Ctrl+C says goodbye. Used for the main menu, the app list, the WhatsApp / Telegram method question and the language list. If raw mode is not available the classic numbered prompt is used instead. The terminal (raw mode, hidden cursor) is restored on a pick, on `q` / Esc / Ctrl+C / Ctrl+D, on any error, on `SIGINT` / `SIGTERM` / `SIGHUP` and on exit.
- **Login steps.** Every login shows `Step N/M - ...` headers (two steps for most apps; Telegram has its own three, below). Waiting states (`Connecting to Telegram...`, `Waiting for you to scan the code...`) are animated spinners on a terminal and never write anything to a pipe or a log.
- **`check` progress bar.** On a terminal `check` redraws one line in place: spinner, bar, percentage, `processed/total`, per-app counters, ETA (after a few seconds of work) and the current pacing / cooldown notice (`pacing 4 s`, `resting until 14:05`). Log lines never garble it: the bar is erased, the line printed, the bar redrawn. The numbers come from the scheduler (`onProgress`), the same events the log lines are made from; nothing new is printed about customer numbers. `check --progress lines` writes plain `progress 40% 80/200 | telegram 50/100, zalo 30/100 | ETA 3 min` lines through the log instead (for logs; at most one every 10 s), `--progress off` nothing extra, default `auto` = the bar on a rich terminal and **nothing extra anywhere else** (so scripted output does not change).
- **Results.** The summary table is coloured on a terminal (`yes` green, `not_found` yellow, `invalid` red, `unknown` / `skipped` and zero counts dim) with the same columns as before. A finished check ends in a `Report saved to <path>` box with the next steps (open the file with Excel / Numbers, `open -R '<path>'` to show it in Finder); an **INCOMPLETE** run adds a bold red warning to the box and to the banner. Only the standard 8-colour palette plus bold / faint / reverse is used (no white, black or bright-black text), which stays legible on light and dark themes; this was chosen, not measured on screen.
- **Telegram in three steps.** Choosing Telegram first shows `Step 1/3 Get your free Telegram API keys (one-time)`, `Step 2/3 Save the keys`, `Step 3/3 Scan the QR code (or enter phone + code)` and **why**: Telegram requires an `api_id` / `api_hash` from every program that logs in, and the QR code appears in Step 3, right after the keys are saved. If the keys are already in the config (or the environment) it says `API keys found` and goes straight to Step 3. Step 1 prints `https://my.telegram.org/apps`, says what to type in the form (App title and Short name: anything; Platform: Other) and, **only on a terminal, only for that one fixed address, and only after you answer yes**, opens it with macOS `open` (no shell). Step 2 asks for the `api_id` (digits) and the `api_hash` (32 hex characters, shown as one mask character per key, never the value), with friendly messages for the usual mistakes (api_hash typed as api_id and the reverse, wrong length); `b` (or Enter) goes back at any of those questions. After a QR scan the screen names the linked account (display name and a **masked** phone number, never the session).
- **Telegram refusals in plain words.** `FLOOD_WAIT_n` (how long to wait), `PHONE_MIGRATE`, `SESSION_PASSWORD_NEEDED`, wrong phone / code / expired code / wrong two-step password, `API_ID_INVALID`, banned or blocked number, too many attempts, and any other Telegram error code (quoted) are translated into one sentence each, in the login language.
- **No shared API keys.** Telegram requires each operator's own `api_id` / `api_hash` (a shared pair would break Telegram's rules and risks getting accounts banned), so the tool never ships one.

## Configure

`checker.config.json` is optional; every key falls back to the built-in default. Unknown keys are rejected so typos fail loudly. [`checker.config.example.json`](../checker.config.example.json) contains every key with its default.

| Key | Default | Meaning |
| --- | --- | --- |
| `defaultRegion` | `"VN"` | Country used for numbers written without a country code (`0901234567`). ISO-3166 alpha-2, upper case, and a real country (`GB`, not `UK`): an unknown code would mark every national number invalid, so it is refused. |
| `dataDir` | `"./data"` | Sessions (secrets!), SQLite results. |
| `maxAgeDays` | `30` | `yes` / `not_found` younger than this are reused, not re-checked. |
| `apps.<app>.enabled` | telegram/whatsapp/zalo `true`; viber/line `false` | Apps checked when `--apps` is not given. |
| `apps.<app>.batchSize` | 10 / 20 / 1 / 100 / 1 | Numbers per call (whole number, at least 1). |
| `apps.<app>.dailyCap` | 200 / 300 / 100 / 1000 / 50 | Numbers per account per local day (whole number, at least 1). |
| `apps.<app>.minIntervalMs`, `jitterMs` | see example | Pause between two batches on one account (`min + random(0..jitter)`). Every duration setting is in milliseconds and at most one year, so an extra zero fails loudly instead of hanging a run. |
| `apps.<app>.rateLimitCooldownMs` | 6 h / 6 h / 24 h / 12 h / 24 h | Rest after a throttle without explicit wait time. |
| `apps.<app>.errorCooldownMs` | 10 min | Rest after an unexpected error. An account failing 3 batches in a row is dropped for the rest of the run. |
| `apps.<app>.options` | | App-specific settings, below. |

Defaults are conservative guesses: platforms do not publish limits. Tune them with a small pilot run of your own. **Throughput = number of accounts x `dailyCap` per day**: 10 000 numbers on one Telegram account at the default `dailyCap` of 200 takes 50 days, so plan for several accounts or a higher, tested cap.

App-specific `options`:

| App | Option | Notes |
| --- | --- | --- |
| telegram | `apiId`, `apiHash` | From <https://my.telegram.org/apps>. The menu asks for them once (api_id digits only, api_hash 32 hex characters, hidden while typing) and saves them here (atomic write, mode 600, other settings kept). Leave `null` to use `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` from the environment. A value in the file wins over the environment. |
| whatsapp | `pairingPhone`, `loginTimeoutMs`, `connectTimeoutMs` | `pairingPhone` (e.g. `"+84901234567"`) makes `login` print a pairing code instead of a QR when no `--method` is given. The menu and `--method code --phone <number>` need no config edit. |
| zalo | none | |
| viber | `registeredQuery`, `syncedQuery`, `authQuery` (**all three required**), `serial`, `adbPath`, `dbPath`, `contactAccountName`, `contactAccountType`, `syncTimeoutMs`, `pollIntervalMs`, `minWaitMs`, `stablePolls`, `foreground` | The Viber database schema is **not built in**: you supply read-only SQL found with `scripts/viber-discover-schema.sh`. The placeholders in the example file are intentionally invalid SQL. See [docs/viber-setup.md](viber-setup.md). |
| line | `loginMode` (`qr` / `password`), `device` | See [docs/line-setup.md](line-setup.md). |

## Log in (once per account)

Each account is a directory `data/sessions/<app>/<account>`; every directory counts as one account for that app. Use several accounts per app to spread the load.

```sh
export TELEGRAM_API_ID=1234567 TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef   # or set in the config
npm run cli -- login telegram --account tg1                      # phone number, login code (hidden), 2FA password (hidden)
npm run cli -- login telegram --account tg1 --method qr          # QR code: Telegram > Settings > Devices > Link Desktop Device
npm run cli -- login whatsapp --account wa1                      # QR -> Linked devices on the phone
npm run cli -- login whatsapp --account wa1 --method code --phone +84901234567   # 8-character pairing code instead of a QR
npm run cli -- login zalo     --account z1                       # QR in the terminal, scan it in the Zalo app
npm run cli -- login viber    --account vb1    # only VERIFIES the emulator/phone setup, see docs
npm run cli -- login line     --account l1     # QR or e-mail/password + PIN on the phone
```

Account names: 1-32 letters, digits, `-`, `_`. Re-running `login` for the same account refreshes its session and clears its cooldown/disabled flag. A first login that fails or is interrupted (Ctrl-C/SIGTERM) removes the half-created directory and registers nothing; account state in the database is only touched after a successful login. Login output (QR codes, URLs, pairing codes) is printed verbatim; it never contains customer numbers. Everything else (scheduler logs, top-level errors) masks every phone-like digit run, including inside URLs and paths. A WhatsApp account whose directory holds no linked device (for example after a failed re-pair) is disabled with a `login whatsapp --account <name>` hint instead of being retried on every run.

### Login screens: QR codes, pairing codes, Telegram credentials

- **One QR renderer for every app** (`src/qr.ts`). The code is drawn with *explicit* colours (pure black on pure white half blocks, white quiet zone of 4 modules, or 2 when the window is short), so it is the same on dark and light terminal themes and square on screen. Without colours (`NO_COLOR` set, `TERM=dumb`, output not a terminal, or a `CI` variable that Node reads as "no colour") it prints a plain `##` / blank version with a note: that one is only right on a light theme. If the window is too small the code is **not** drawn (a wrapped code cannot be scanned): a message gives the columns x rows needed (`Enlarge the window, or press Cmd+minus`), and the code appears by itself when the window is big enough. WhatsApp's current code is 61 modules (a 277-character link, measured on a live capture) and needs a window of about 72 x 39 (columns x rows; 68 x 37 with the smaller quiet zone): the default 80x24 Terminal window is too short for it, so expect the enlarge message there. When the service rotates the code (WhatsApp every ~20 s after the first one, Telegram every ~30 s, Zalo after ~100 s) the new one replaces the old one on a terminal and is marked `New QR code (#n)`; it is removed when the login ends.
- **Why the old picture did not scan.** The previous `qrcode-terminal` `small: true` picture used the terminal's own colours, a 1-module border (and none at the bottom for an odd size), and a WhatsApp code of 61 modules is 31+ rows, so it does not fit a default 24-row window. `tests/qr.test.ts` rasterises both outputs and decodes them with jsQR: the old one decodes only with ideal dark-theme colours (so a dark theme alone does not explain a failure: that was *measured*, not assumed) and is inverted on a light theme; the new one decodes on dark, light and hostile themes. That is a simulation, not a phone camera.
- **WhatsApp.** Menu option 1 = pairing code (recommended, default): the menu asks for the account's phone number (checked with the same normaliser as the CSV), `login --method code --phone <number>` asks Baileys for an 8-character code and prints it with *Link with phone number instead*. Option 2 = QR. A QR scan failed on a real iPhone ("check your connection and try again") because WhatsApp now sends `companion_reg_refresh` after a scan and Baileys 7.0.0-rc14 ignores it (WhiskeySockets/Baileys#2737); the adapter now answers it (new secret, same code redrawn) and uses the WhatsApp Web version WhatsApp serves instead of Baileys' bundled one. Not yet confirmed with a phone: see [docs/whatsapp-setup.md](whatsapp-setup.md). After a login the menu prints one success line and *Next step: choose 1*.
- **Zalo.** zca-js hands over the login QR only as a PNG (`data.image`; its `data.code` is a different, internal token). `src/qr-png.ts` reads the module grid back out of that picture (plain-PNG decoder on Node's `zlib`, no dependency; tolerates the rounded finder corners of Zalo's picture) and redraws it with the shared renderer, so no file is written. Only if the picture cannot be read does the adapter fall back to saving `login-qr.png` (mode 600, inside the account directory, deleted afterwards), printing its path and, on a macOS terminal, opening it.
- **Telegram.** Option 1 = QR login (`client.start({ qrCodeHandler })`: mtcute 0.32 supports it; every token Telegram issues is drawn, a two-step password is asked hidden after the scan, nobody scanning for 5 minutes ends the login), option 2 = phone number + login code. With no `--method` the command keeps asking for phone + code. The menu walks through the `api_id` / `api_hash` first when they are missing: see [Terminal UI](#terminal-ui-colours-arrow-keys-progress-bar) and [docs/telegram-setup.md](telegram-setup.md).
- **LINE** uses the same renderer for its QR URL.

Step-by-step guides with the exact prompts, risks and error meanings: [README.md](README.md).

## Check

```sh
npm run cli -- check customers.csv --out report.csv
```

- The phone column is auto-detected (header like `phone`, `SĐT`, `mobile`, ...; or the column whose cells parse as phone numbers). Force it with `--column phone` or `--column 3` (1-based). Delimiter `,` `;` or tab, line endings LF / CRLF / CR, a UTF-8 BOM and Excel's **Unicode Text** export (UTF-16 with BOM) are handled. A binary file such as an `.xlsx` workbook is refused with a hint to save as *CSV UTF-8*. Cells Excel turned into scientific notation (`8.49E+10`) lost their digits and are reported `invalid`, never guessed.
- Numbers are normalised to E.164, de-duplicated (first spelling is kept in the `input` column) and checked once per app.
- `--apps telegram,zalo` limits the run; other columns become `skipped`. `--max-age 7` reuses answers younger than 7 days (`0` re-checks everything); a result dated in the future is never reused, even with `--max-age 0` or a huge value. `report` accepts `--max-age` too (it only decides which cells are flagged stale).
- **Output file safety.** `--out` must not be the input CSV (also through a symlink or hard link) nor anything inside `dataDir`, however its letters are cased on a case-insensitive volume (macOS, Windows), even when the file does not exist yet. An existing `--out` is replaced only when it is a previous report of this tool (or empty); any other existing file needs `--force`. Cells that a spreadsheet would run as a formula (`=`, `+`, `-`, `@`, tab, CR or LF at the start, also in full-width form or after spaces) are written with a leading `'` in the `input` column. The report is written to a private temp file and renamed into place, so an interrupted run never leaves a half-written report; temp files of killed runs are removed by the next run once they are 15 minutes old.
- **One run at a time.** `data/check.lock` stops a second `check` from sharing accounts with a running one (a second WhatsApp connection would disable that account). `login` and `account-reset` take the same lock, so they refuse to run next to a `check` (or each other) instead of re-pairing or resetting an account that is in use; wait for the other command or, if its process is gone, delete the lock file. The lock is published atomically (private file + `link()`), and a stale lock (dead owner) is reclaimed under a separate guard `check.lock.reclaim`. A guard left by a process killed *during* that recovery is **never** broken automatically (breaking it cannot be made safe against a second reclaimer): the command stops with `Lock recovery was interrupted … Repair: … delete …` and a person removes the named file once no command is running. Non-`ENOENT` read errors on the lock (permissions, I/O) are surfaced, never treated as a stale owner. The lock trusts a pid on this host: use a local, non-synced data directory.
- **Lifecycle exclusion (install/uninstall vs commands).** `check`, `login`, `report`, `accounts`, `account-reset` and `doctor` register in `~/Library/Application Support/phone-app-checker-lifecycle/shared/<pid>.<token>` **before** the home is bootstrapped or any database opened. `install.sh` / `uninstall.sh` publish `maintenance.lock` there, hold it for their whole run (including the `DELETE` prompt and the copy) and then read the registrations; every command reads the barrier after registering, so neither side can miss the other. The directory is outside the app home, the install tree and any `dataDir`, so it also covers `--config`, an external `dataDir` and another `PHONE_APP_CHECKER_HOME`. Maintenance waits up to 3 s for registered commands (then refuses naming the pid); registrations of dead processes are ignored. A barrier left by a killed install/uninstall fails everything closed with `An earlier install or uninstall … was interrupted … delete …maintenance.lock` and is never broken automatically. Every refusal (barrier, registration, run lock, reclaim guard) names the exact file and says `if nothing is running, delete <file>`: after a crash or power cut the recorded pid may have been reused by an unrelated process, and a pid that exists but cannot be signalled (EPERM) counts as alive in both Node and the shell scripts, so the check fails closed. The hidden `data-dir` command is exempt (the scripts call it while holding the barrier).
- Results are committed to SQLite after every batch. **Ctrl-C (or SIGTERM) finishes the current batch, writes the report and exits 130**; a second Ctrl-C quits immediately. Running again continues where it stopped; numbers with a fresh answer are not asked again. A re-check that gets no answer never overwrites an earlier `yes` / `not_found`: the old answer stays, **but it is not re-confirmed**: its own time is in `<app>_checked_at` and `<app>_stale` flags it once it is older than the max age (`last_checked_at` is the newest time across all apps and attempts, so it can look recent while one app's answer is old). SIGKILL cannot be handled: results committed before it are kept, but the in-flight batch may be asked again and Telegram's imported contact or Viber's injected contacts may not have been cleaned up (Telegram's cleanup is best effort; Viber removes leftovers at the start of the next batch). Use one Ctrl-C and wait for the report. A sleeping laptop suspends the run until it wakes.
- A batch that keeps failing with an unexpected error although this run already got answers (e.g. one number a platform rejects) is retried, then parked after two failures and left `unknown` for this run, even when it is the last batch left. No account is put on cooldown for it (cooldowns its failures caused are lifted) and parked failures do not count towards dropping an account (three other failures in a row do). With no success yet in the run, repeated failures are treated as an outage: the account is dropped for the run after three in a row (not banned: usable again next run). Numbers from a failed batch are remembered in the database until they are answered; the next run checks them **last and one by one**, so the healthy numbers that shared a batch with a rejected one get their answer, and a few rejected numbers at the top of the list cannot stop everything behind them.
- When every account is cooling down or at its daily cap, `check` sleeps until one is available, which can mean days for big lists. Run it somewhere that will not sleep (`caffeinate -i npm run cli -- check ...`, `tmux`), or pass `--no-wait` to stop instead and re-run later (cron).
- **Progress.** On a terminal a progress bar is drawn in place (see [Terminal UI](#terminal-ui-colours-arrow-keys-progress-bar)); `--progress lines|off|auto` chooses plain lines, nothing, or the default. Without a terminal the output is the same as before.
- **Run summary and INCOMPLETE banner.** Every app gets one line `needed N, attempted A, conclusive C, inconclusive I` with a reason (`no usable account`, cooldown, daily cap, errors, parked batches, unknown answers), and `(all conclusive)` replaces `(done)` only when nothing is inconclusive. If any number has no fresh `yes`/`not_found` from this run, a banner is printed **last** (after `Report written to …`): `INCOMPLETE: X of Y checks have no fresh yes/not_found answer. The report is NOT final …` with per-app reasons (`no_accounts`, `adapter_error`, `aborted`, cooldown, daily cap, …) and `Next resume: <ISO time>` when known (earliest across apps). Apps without any logged-in account are included (`no_accounts`; also logged as `no accounts ... Run: login <app>`) and stay `unknown`. Exit code stays `0` (`130` if interrupted): it means the command produced its output, **not** that every number was conclusively checked, so read the banner and the `<app>_stale` columns. A file with zero valid numbers is an error: `check` exits `1` with `no valid phone numbers (N invalid); check --column …` before the store is opened and writes no report.

Monthly routine: put the new export through `check`; answers younger than `maxAgeDays` are reused, the rest are refreshed.

## Report only, accounts

```sh
npm run cli -- report customers.csv --out report.csv      # rebuild report.csv from stored results, no network
npm run cli -- accounts                                    # per account: ready / cooling down until ... / DISABLED: reason, used today
npm run cli -- account-reset telegram tg1                  # clear cooldown / disabled flag after you fixed the cause
```

`report` shows the last known answer even when older than `maxAgeDays`: such cells have `<app>_stale` = `yes` and the summary prints a `STALE:` line (use `--max-age <days>` to choose the threshold; a future-dated result is always stale). With zero valid numbers it still writes the report (only `invalid` rows), prints `WARNING: no valid phone numbers (N invalid)` and exits `1`, like `check`.

## Data and secrets

| Path | Content | Handling |
| --- | --- | --- |
| `data/` itself | Everything below | Must be a real directory owned by you (a symlink is refused); created mode 700 and repaired to 700 on every run. |
| `data/sessions/**` | Logged-in sessions of the checking accounts (account dirs mode 700) | Full access to those accounts. File modes are set to 600 by the adapters (Telegram `session.sqlite*`, LINE, Zalo, Viber state, QR image; WhatsApp files are set to 600 when a session closes). Never commit, share or put in a synced folder. |
| `data/checker.db` (+ `-wal`/`-shm`) | Every checked number, its status and time, plus account cooldown state | Customer personal data. Created mode 600 before SQLite opens it; mode of the database and its sidecars is repaired to 600 on open; symlinks are refused. Telegram's own session database stores no customer profiles (see [docs/telegram-setup.md](telegram-setup.md)). |
| `data/check.lock` | pid of a running `check`, `login` or `account-reset` | Removed on exit, SIGINT/SIGTERM/SIGHUP; a lock left by a dead process is reclaimed on the next run, **unless** its reclaim guard `data/check.lock.reclaim` was abandoned mid-recovery: then the run refuses until a person deletes that file (see "One run at a time" under Check). |
| `~/Library/Application Support/phone-app-checker-lifecycle/` | `shared/<pid>.<token>` registrations of running commands; `maintenance.lock` while install/uninstall runs | Outside home, install tree and `dataDir`; emptied by the uninstaller; an abandoned `maintenance.lock` fails closed until deleted by hand. |
| `~/Applications/phone-app-checker/.incoming.*`, `.replaced.*` | New copy being prepared / previous copy kept until the new `--version` self-check passes | Removed when the install finishes; a killed install leaves `.replaced.<version>.*`, which the next `install.sh` restores. |
| `report.csv`, input CSVs | Customer numbers | `report.csv` is written mode 600 through a private temp file and renamed into place; input CSVs keep their own mode. `*.csv` is git-ignored. |

**Refused folders and purge rules.** The app home (`PHONE_APP_CHECKER_HOME`) and `dataDir` may not be `/`, the user's home or a parent of it, any of `Documents`, `Desktop`, `Downloads`, `Library`, `Applications`, `Movies`, `Music`, `Pictures`, `Public`, `.local`, `.config`, `Library/Application Support`, `.local/bin` (matched by inode and case-insensitively, so aliases and symlinks do not slip through, **even when a marker file exists**), nor overlap `~/Applications/phone-app-checker` (replaced on install, deleted on uninstall). Checked before anything is written. `uninstall.sh --purge-data` deletes a whole tree only when it is a real directory named `phone-app-checker`, owned by you, not overlapping the install tree, containing a real (non-symlink) `checker.config.json` or `data/checker.db`; custom or shared folders are refused even with `--yes` (delete what you created there by hand), and an absolute external `dataDir` is reported as retained, not deleted. The configured `dataDir` is read **before** anything is removed (from the installed copy, or from `checker.config.json` when the program is already gone, e.g. after an ordinary uninstall); if it is set but cannot be located with certainty, `--purge-data` refuses before the prompt and keeps the config. Anything other than `DELETE` at the prompt still uninstalls the program and keeps the data; delete the data later with `uninstall.sh --purge-data` from the downloaded bundle. Uninstall also removes `~/.zprofile`/`~/.bash_profile` again when the installer created the file and it is empty after its PATH block is removed. A plain uninstall refuses when the home or `dataDir` lies inside the install tree. Purge is local file deletion only: not a remote logout (unlink the devices first) and not secure erasure (backups and Time Machine snapshots may keep copies).

**Install activation.** `install.sh` holds the maintenance barrier, copies to `.incoming.<version>.<pid>`, moves the old copy of the same version to `.replaced.<version>.*`, activates, runs `--version`, and only then deletes the old copy; any failure (or an interruption caught by the EXIT trap) rolls back, a SIGKILL leaves the old copy for the next run to restore. `current` and `~/.local/bin/phone-app-checker` switch with an atomic rename, and shell profiles (also through a symlink) are rewritten beside the target and renamed over it. Rollback to an older retained version: `bash ~/Applications/phone-app-checker/<version>/install.sh`.

**Schema v2.** `data/checker.db` uses schema version 2 (adds `failed_checks`, migrated in place from v1). A database written by schema 2 cannot be opened by an older build (`Database was written by a newer version`; the version check runs before anything is changed): do not downgrade over existing data without a backup of `checker.db`.

Delete `data/` and the CSVs when you no longer need them.

**Packaged app (macOS download).** When the command is started through the bundled `phone-app-checker` wrapper it sets `PHONE_APP_CHECKER_HOME`, and everything above moves out of the working directory: the config is `~/Library/Application Support/phone-app-checker/checker.config.json` (created from the example on first run) and `data/` is `~/Library/Application Support/phone-app-checker/data` (relative `dataDir` values are resolved against that folder). Input CSVs and `report.csv` stay in the current directory. With the variable unset (a source checkout) nothing changes.

## Per-app prerequisites and limits

| App | You need | Reliability and limits |
| --- | --- | --- |
| Telegram | >= 2 SIMs recommended, `api_id`/`api_hash`, aged account | `yes` = Telegram resolved the number at that time (an observation, not an identity or activity check); `not_found` can be a privacy setting. Throttling shows up as `retry_contacts` / `FLOOD_WAIT`; `PEER_FLOOD` disables the account. [guide](telegram-setup.md) |
| WhatsApp | >= 1-2 SIMs, the phone at hand for the QR / pairing code | `not_found` fairly reliable. Aggressive lookups get numbers banned; Baileys v7 is a release candidate. [guide](whatsapp-setup.md) |
| Zalo | A Zalo account; the Zalo app to scan the QR | **Vietnam (`+84`) only**; other countries are `skipped`. `not_found` also covers numbers hidden from phone search. [guide](zalo-setup.md) |
| Viber | Android emulator (Google **APIs** image) or rooted phone, `adb`, `sqlite3`, a SIM for activation, the pinned Viber APK, **schema discovery and your three SQL queries** | No lookup API: contacts are injected and Viber's own sync is read from its database. Slow (batches every ~30 min by default). **Needs a manual spike per Viber version.** [guide](viber-setup.md) |
| LINE | A LINE account (ideally HK/JP/KR/TW/TH or pre-13.11), terminal for login | Phone search is meaningful only in those regions; elsewhere `not_found` is close to no information. [guide](line-setup.md) |

## What is verified, and what is not

Automated (`npm test`, no accounts needed): CSV parsing and normalisation, config validation, the scheduler (batching, caps, cooldowns, resume, Ctrl-C, parking a batch that keeps failing), SQLite persistence and its file permissions, report/summary and its output-file safety, the run lock, the CLI end to end with a **test-only injected adapter**, the five real adapters failing closed with setup hints when no credentials exist, and each real adapter's error classification (`yes`/`not_found`/rate-limit/ban/other) against test doubles of the third-party client (Telegram's real mtcute storage is exercised to prove no customer profile is persisted), including the Viber adapter against a simulated Android device with a real SQLite file. The suite passes on Node 24.14 and on Node 22.18.0 (the minimum in `engines`; run there from an install made with that Node, because `better-sqlite3`, used by mtcute, is a native module built per Node version).

**Live accounts.** Only WhatsApp has been exercised against the real service, by the maintainer: one account linked with a pairing code and a handful of lookups (a registered number returned `yes`, an unregistered one `not_found`). No known-answer trial of ~20 numbers has been done for any app. **Telegram, Zalo, Viber and LINE have not been verified against the live platforms**, and the live-account pilot per app is still open. Not verifiable without credentials/devices:

- That each unofficial client still speaks the current Telegram / WhatsApp / Zalo / LINE protocol, including the exact error names/codes the adapters map to `rate limit` / `ban`.
- That `yes` / `not_found` match reality: run `check` on a ~20-number staff file with known answers per app and compare before trusting a customer run. A silent soft throttle on the platform side can look like `not_found`; the tool cannot detect it.
- Real rate limits and the throughput you can sustain without losing accounts.
- Viber: the DB schema and queries for your Viber version, root access, whether Viber activates on the emulator (fallback: a rooted phone), and that the device has `tar` for the single-archive database read.
- LINE: availability of phone search for your account's region.

## Development

```sh
npm run typecheck     # tsc --noEmit
npm test              # vitest
npm run smoke         # end-to-end demo (login, check, resume, report) with a test-only adapter
npm run release:build    # macOS arm64 portable archive -> dist/ (needs network + Apple Silicon; see below)
npm run release:verify   # clean-room install/uninstall check of the archive in dist/
```

`release:build` produces `dist/phone-app-checker-<version>-macos-arm64.tar.gz` plus a `.sha256`, bundling the pinned official Node.js build, the production `node_modules` built by that Node, and the install/uninstall scripts from `release/`. `release:verify` unpacks it in a temporary HOME without Node on `PATH` and exercises install, `doctor`, offline `report`, reinstall and uninstall. Nothing is published or uploaded by these scripts; the `release` GitHub workflow builds and uploads the archive for tags. The tester's guide is [install-macos.md](install-macos.md) (shipped inside the archive as `INSTALL.md`, Vietnamese as `INSTALL.vi.md`), together with `LICENSE` and `THIRD_PARTY_LICENSES.md`.

Layout: `src/cli.ts` commands, `src/scheduler.ts` batching/pacing, `src/store.ts` SQLite, `src/adapters/<app>.ts` the five real adapters behind `src/types.ts` (`Adapter`/`Session`), `src/android/adb.ts` adb wrapper for Viber. CLI/scheduler tests substitute adapters only through the `loadAdapter` seam of `createProgram`; adapter tests replace only the third-party client or `adb` with test doubles (`vi.mock`). There is no fake mode at runtime.
