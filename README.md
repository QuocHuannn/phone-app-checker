<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-horizontal-dark.svg">
    <img src="docs/assets/logo-horizontal.svg" alt="Phone App Checker (phone-app-checker)" width="420">
  </picture>
</h1>

**Find out which messaging apps a phone number is registered on: Telegram, WhatsApp, Zalo, Viber, LINE, Threema, Matrix.**
Local command-line tool. CSV in, CSV report out. No messages are ever sent.

[![CI](https://github.com/QuocHuannn/phone-app-checker/actions/workflows/ci.yml/badge.svg)](https://github.com/QuocHuannn/phone-app-checker/actions/workflows/ci.yml)
[![License: GPL v3+](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/QuocHuannn/phone-app-checker?display_name=tag&sort=semver)](https://github.com/QuocHuannn/phone-app-checker/releases)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-339933?logo=node.js&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20arm64%20%7C%20Node%20(source)-lightgrey)](#quick-start)

</div>

phone-app-checker reads a CSV of phone numbers, normalises them to E.164, and asks each enabled messaging app whether the number has an account. It writes one `report.csv` row per number with one status column per app, and prints a summary. It runs entirely on your machine with accounts that **you** log in, paces its requests per account (batch sizes, daily caps, cooldowns), resumes after an interruption, and stores nothing about a person except the number, the status and the time.

> [!WARNING]
> **Responsible use: read before you run it.**
>
> - **Consent only.** Use it only for numbers of people who agreed to be contacted or checked. The tool cannot verify consent. Looking up whether a number has an account is processing of personal data: **check your local law** before you start (examples: Vietnam PDPL Law 91/2025/QH15, GDPR, Singapore and Malaysia PDPA, Indonesia PDP Law, Australia Privacy Act, New Zealand Privacy Act, Korea PIPA, US state privacy laws). This is not legal advice.
> - **Platform terms and bans.** Telegram, WhatsApp, Zalo and LINE are reached through unofficial clients, and Viber by driving the real app. That very probably violates each platform's terms of service, and the accounts and SIMs you use **can be restricted or permanently banned**. Use dedicated, disposable accounts; never a personal or business-critical number. Threema and Matrix use official lookup interfaces, but their terms still apply to you.
> - **Threema and Matrix send a hash of the number to a third party.** A Threema lookup sends an HMAC of the number to Threema's Gateway; a Matrix lookup sends a salted hash of the number to an identity server. The Threema key is public, so its hash is a pseudonym, not protection. Treat both as disclosing the number to that operator. Both apps are **disabled by default**.
> - **Not affiliated.** Independent project; not affiliated with, endorsed by or sponsored by Telegram, WhatsApp/Meta, Zalo/VNG, Viber/Rakuten, LINE/LY Corporation, Threema or the Matrix.org Foundation.
> - **No accuracy guarantee.** `not_found` can simply mean the person hides their number from search or never linked it. LINE results are meaningful only in HK / JP / KR / TW / TH; Zalo is checked for Vietnam (+84) numbers only. Only part of this has been verified against the live platforms: see [Verification status](#verification-status).
>
> Full text: [docs/responsible-use.md](docs/responsible-use.md).

## Contents

[Features](#features) · [Quick start](#quick-start) · [Interactive menu](#interactive-menu) · [CLI reference](#cli-reference) · [Configuration](#configuration) · [Performance](#performance) · [How it works](#how-it-works) · [Per-app setup](#per-app-setup) · [Verification status](#verification-status) · [FAQ](#faq) · [Roadmap](#roadmap) · [Limitations](#limitations) · [Contributing](#contributing) · [Security](#security) · [License](#license)

## Features

| App | Method | Limits and caveats | Confidence |
| --- | --- | --- | --- |
| **Telegram** | A logged-in user account (MTProto via [mtcute](https://github.com/mtcute/mtcute)) imports numbers as temporary contacts and removes them after each batch. Needs your own free `api_id` / `api_hash`. | `not_found` can be a privacy setting. Throttling shows as `FLOOD_WAIT` / `retry_contacts`; `PEER_FLOOD` disables the account. Default cap 200 numbers/day/account. | Tests with doubles only; **not verified live** |
| **WhatsApp** | Linked device of a dedicated account ([Baileys](https://github.com/WhiskeySockets/Baileys) v7, a release candidate) asks WhatsApp's contact-discovery service which numbers are registered. Pairing code (recommended) or QR. | No setting hides a user from this lookup, so `not_found` is fairly reliable, but aggressive lookups get numbers banned. Default cap 300/day/account. | Linked with a pairing code and a few lookups answered correctly on a real account; **no 20-number known-answer trial yet** |
| **Zalo** | Logged-in session ([zca-js](https://github.com/RFS-ADRENO/zca-js)); finds a user by phone number. QR login in the terminal. | **Vietnam (+84) numbers only**; others are `skipped`. `not_found` covers "no account" and "hidden from phone search". Default cap 100/day/account. | QR login reached credentials-saved once on the maintainer's machine; **lookups not verified live** |
| **Viber** | No lookup API exists. Injects contacts on an Android emulator / rooted phone, lets Viber sync, reads which ones Viber marked registered from its own database using SQL **you** supply. | Slow (batches ~30 min apart), needs `adb`, root and a manual schema spike per Viber version. Always one batch at a time. Disabled by default. | Tests against a simulated device only; **not verified live** |
| **LINE** | Logged-in secondary device ([linejs](https://github.com/evex-dev/linejs)); read-only phone lookup. QR or e-mail/password login. | Phone search is meaningful **only in HK / JP / KR / TW / TH**; elsewhere `not_found` is close to no information. Disabled by default. Default cap 50/day/account. | Tests with doubles only; **not verified live** |
| **Threema** | The official [Threema Gateway](https://gateway.threema.ch) `lookup/phone_hash` call, over plain HTTPS: no unofficial client, no new dependency. Needs a Threema Gateway ID and API secret (Gateway is a paid service; whether lookups use credits is not verified). | Finds only people who **linked a phone number** to their Threema ID, so `not_found` mostly means "not linked". The hash key is public: the number is effectively disclosed to Threema. Disabled by default. Default cap 100/day. | Tests against stubbed HTTP responses only; **not verified live** |
| **Matrix** | The Matrix [identity-service](https://spec.matrix.org/v1.19/identity-service-api/) 3PID lookup (salted SHA-256 of the number), over plain HTTPS: no `matrix-js-sdk`, no new dependency. Needs a Matrix account to obtain an identity-server token. | Finds only people who **linked their phone number to an identity server**, which many servers no longer keep; current coverage is unknown. The number's hash goes to the identity server. Disabled by default. Default cap 100/day. | Tests against stubbed HTTP responses only; **not verified live** |

Also: phone-column auto-detection (header names or content), delimiter and encoding sniffing (including Excel's UTF-16 export), de-duplication, result cache (`maxAgeDays`), several accounts per app with opt-in parallel accounts (`maxParallelAccounts`), resumable runs (Ctrl-C finishes the batch and writes the report), a live per-account run dashboard, masked phone numbers in logs, private file permissions, spreadsheet-formula neutralisation, an interactive menu in six languages with recent files and a CSV preview, versioned config with automatic migration, and an offline `doctor` self-check.

## Quick start

### Option A: macOS portable download (Apple Silicon, no Node.js needed)

Requires an Apple Silicon Mac, macOS 13.5 or newer. Download the archive and its checksum from the [latest release](https://github.com/QuocHuannn/phone-app-checker/releases/latest), then:

```sh
cd ~/Downloads
shasum -a 256 -c phone-app-checker-0.2.0-macos-arm64.tar.gz.sha256   # must print: ...tar.gz: OK
tar -xzf phone-app-checker-0.2.0-macos-arm64.tar.gz
bash phone-app-checker-0.2.0-macos-arm64/install.sh
```

Open a **new** Terminal window and run `phone-app-checker`. The archive carries its own official Node.js runtime and precompiled JavaScript, installs under `~/Applications/phone-app-checker`, and keeps config, sessions and results in `~/Library/Application Support/phone-app-checker`. The archive is not signed or notarised; `install.sh` clears the download quarantine flag. Step-by-step guide for non-developers: [docs/install-macos.md](docs/install-macos.md) (Vietnamese: [docs/install-macos.vi.md](docs/install-macos.vi.md)). Uninstall: `~/Applications/phone-app-checker/current/uninstall.sh` (add `--purge-data` to delete data as well).

**Upgrading from 0.1.0:** run the new `install.sh`; it keeps your config, sessions and results. The first 0.2.0 start upgrades `checker.config.json` and `checker.db` in place and keeps a mode-600 backup of the old config, `checker.config.json.v1.bak`. **0.1.0 cannot open the upgraded database**, so to go back restore that backup and the old version together; see [Configuration](#configuration) and the [CHANGELOG](CHANGELOG.md#020---2026-10-10).

### Option B: from source (Node.js >= 22.18)

```sh
git clone https://github.com/QuocHuannn/phone-app-checker.git
cd phone-app-checker
npm ci                                                  # the LINE client comes from the JSR registry; .npmrc already points to it
cp checker.config.example.json checker.config.json      # optional; git-ignored
npm run cli -- doctor                                   # offline readiness check
npm run cli -- login whatsapp --account wa1 --method code --phone +84901234567
npm run cli -- check customers.csv --apps whatsapp --out report.csv
```

Replace `npm run cli --` with `phone-app-checker` if you installed the macOS archive or ran `npm link`. Run `phone-app-checker` with no arguments in a terminal for the [interactive menu](#interactive-menu). A source checkout runs the TypeScript directly; `npm run build` compiles it to `build/js/`, which is what the macOS archive ships.

### First run, safely

1. `doctor` (offline): runtime, config, data folder and each adapter's prerequisites. Green does **not** prove an account works. `doctor --deep` also loads every adapter module (slower).
2. Log in a **dedicated** account per app ([setup guides](#per-app-setup)).
3. Check a small file of ~20 numbers whose answers you already know. Compare. Only then run the real list.
4. Watch `phone-app-checker accounts` (it shows the time each batch took) and raise `batchSize` / `dailyCap` slowly.

## Interactive menu

With no arguments in a terminal the tool opens a numbered, arrow-key menu (a plain numbered tier when colours or raw mode are unavailable). The sample below is the real output at 80 x 24 with two accounts logged in:

```text
╭─ Phone App Checker 0.2.0 ─────────────────────────────────────────────
│ Accounts ready:
│ ✔ telegram 1 account · ✔ whatsapp 1 account · ○ zalo none
│ ○ viber none · ○ line none · ○ threema none · ○ matrix none
╰───────────────────────────────────────────────────────────────────────

❯ 1 Check a CSV file
  2 Log in an app account
  3 View logged-in accounts
  4 Rebuild the latest report
  5 Check this Mac is ready (doctor)
  6 Guide / warnings
  L Language / Ngôn ngữ / Bahasa / 언어 / 语言: English
  0 Quit
↑↓ move · Enter select · q quit
```

- **One back key.** `b` goes back on every prompt (Esc and `q` do the same in lists); Enter takes the default shown in the prompt.
- **Check a CSV file.** Drag the file from Finder into the window, or pick one of the **last 5 files** you used. The menu then shows a **preview** (detected phone column, row counts, usable and unusable numbers, countries) and asks you to confirm before anything runs. A checklist (Space ticks) chooses the apps. "Clear the list and stop remembering files" is in the file picker; the list is a private file (mode 600) in the app folder.
- **QR login.** The menu checks the window size **before** it starts a QR login and tells you how many columns x rows the code needs, with a pairing-code alternative where the app has one.
- **Accounts view.** `r` resets a cooling-down account, `l` goes to login.
- **Run dashboard.** While a check runs, a live panel shows one row per account (state, done, per-status counts, last batch time), rate, ETA and a cooldown countdown in local time, plus the path of the run log:

```text
╭─ Checking customers.csv · 4 numbers ────────────────────────────────────────
│ Elapsed 3 s · 149/min
│
│ APP       ACCOUNT  STATE   DONE  RESULTS    LAST
│ telegram  a        ✔ done  4/4   0y 4nf 0u  0.7s
│ zalo      z        ✔ done  3/3   0y 3nf 0u  0.7s
│
│ ████████████████████████████  100%  7 of 7 checks (4 numbers x 2 apps)
│ yes 0 · not_found 7 · unknown 0
│ Ctrl+C finishes this batch and saves the report.
│ Log: <data dir>/check-<timestamp>.log
╰──────────────────────────────────────────────────────────────────────────────
```

  The panel redraws at most once a second and shrinks on short windows. A run ends with `Done in 3 s · 4 numbers · 0 unfinished`, the apps' result table, `Accounts used: ...` and a `Report saved` box; press `o` there to reveal the report in Finder. The run log (`check-*.log` in the data folder, mode 600, last 5 kept) holds the per-batch detail. This sample was captured from a run with test-only adapters on the maintainer's Mac.
- **Plain tier.** `--plain` (or `PHONE_APP_CHECKER_PLAIN=1`, `NO_COLOR`, `TERM=dumb`) turns off colour and all cursor movement: prompts are numbered, the run prints timestamped lines (`05:54 progress 100% 7/7 | telegram 4/4, zalo 3/3`) with the same facts as the dashboard.

English is the default; press `L` for Vietnamese, Bahasa Indonesia, Bahasa Melayu, Korean or Simplified Chinese (the last four are first-draft machine translations that need native review). Details: [docs/reference.md](docs/reference.md#interactive-menu).

## CLI reference

```text
phone-app-checker [--config <path>] [--plain] <command>

  login <app> [--account <name>] [--method qr|code] [--phone <number>]
      Log an account in (QR / pairing code / OTP / API credentials); the session is stored under data/sessions.
  check <csv> [--out <file>] [--apps <list>] [--column <name|index>] [--max-age <days>]
              [--no-wait] [--force] [--progress auto|lines|off]
      Check every number and write the report. Resumable; fresh results are reused.
  report <csv> [--out <file>] [--apps <list>] [--column <name|index>] [--max-age <days>] [--force]
      Rebuild the report from stored results without any network access.
  accounts
      Per account: ready / cooling down until ... / DISABLED: reason, usage today and batch time (avg / last).
  account-reset <app> <account>
      Clear a cooldown or disabled flag after you fixed the cause.
  doctor [--deep]
      Offline readiness check; exit 1 when something blocks use. --deep also loads every adapter module.
```

`--apps` takes `telegram,whatsapp,zalo,viber,line,threema,matrix`. Exit codes: `0` success, `1` error or no valid numbers, `130` interrupted (the report is still written). `--help` on any command lists every option. `--plain` is a global flag; `--progress` only chooses how `check` reports progress (`auto` = the dashboard on a rich terminal and nothing extra elsewhere, `lines` = plain progress lines, `off`).

**Report.** One row per unique number: `input, e164, country, telegram, whatsapp, zalo, viber, line, threema, matrix, last_checked_at`, then `<app>_checked_at` and `<app>_stale` per app.

| Status | Meaning |
| --- | --- |
| `yes` | The app answered that the number has an account (an observation at that time, not proof of identity or activity). |
| `not_found` | The app returned no account. **Not proof the person has none**: they may hide themselves from search, or (Threema, Matrix) never have linked their number. |
| `unknown` | Not checked yet, or the check failed or was throttled. Re-run `check`. |
| `skipped` | App disabled or not selected, or the number is outside the app's scope (Zalo: +84 only). |
| `invalid` | The cell is not a valid phone number for `defaultRegion`. |

An `INCOMPLETE` banner is printed last when some numbers have no fresh answer; run the same command again to continue.

## Configuration

`checker.config.json` is optional and every key has a default; unknown keys are rejected so typos fail loudly. [`checker.config.example.json`](checker.config.example.json) lists everything. Packaged macOS app: `~/Library/Application Support/phone-app-checker/checker.config.json`.

| Key | Default | Meaning |
| --- | --- | --- |
| `configVersion` | `2` | Written by the tool. A file without it is a 0.1.0 file and is upgraded automatically (below). A file with a newer number than this build knows is refused untouched. |
| `defaultRegion` | `"VN"` | ISO-3166 alpha-2 country used for numbers without a country code (`0901234567`). |
| `dataDir` | `"./data"` | Sessions (secrets) and the SQLite result database. |
| `maxAgeDays` | `30` | `yes` / `not_found` younger than this are reused, not re-checked. |
| `apps.<app>.enabled` | telegram, whatsapp, zalo: `true`; viber, line, threema, matrix: `false` | Apps checked when `--apps` is not given. |
| `apps.<app>.batchSize` | 10 / 20 / 1 / 100 / 1 / 1 / 1 | Numbers per call (telegram / whatsapp / zalo / viber / line / threema / matrix). |
| `apps.<app>.dailyCap` | 200 / 300 / 100 / 1000 / 50 / 100 / 100 | Numbers per account per local day. |
| `apps.<app>.minIntervalMs`, `jitterMs` | see example | Pause between batches on one account: `min + random(0..jitter)`. |
| `apps.<app>.rateLimitCooldownMs`, `errorCooldownMs` | 1-24 h / 10 min | Rest after a throttle / an unexpected error. |
| `apps.<app>.maxParallelAccounts` | `1` | Accounts of this app that may have a batch in flight at once. `1` is the 0.1.0 behaviour. Viber is always one (one device) and refuses a higher value. See [Performance](#performance). |
| `apps.<app>.options` | | App-specific: Telegram `apiId` / `apiHash`; WhatsApp `pairingPhone`; LINE `loginMode`, `device`; Matrix `homeserver`, `identityServer`; Viber SQL queries and adb settings. |

Throughput is accounts x `dailyCap` per day: 10 000 numbers on one Telegram account at the default cap takes 50 days. The defaults are conservative guesses; platforms publish no limits. Raising `maxParallelAccounts` only helps when a batch takes long compared with the pacing pause; the `accounts` command shows each account's real batch time, so measure before you raise it, and remember that more simultaneous sessions raise the ban exposure. Details, data layout and secrets handling: [docs/reference.md](docs/reference.md).

**Migration and backup.** The first time 0.2.0 reads a 0.1.0 config it writes the upgraded file (mode 600, atomically) and keeps the old one as `checker.config.json.v1.bak` next to it (mode 600; an existing backup is never overwritten, a numbered one is added), then prints one line naming the backup. The SQLite database is upgraded in place by explicit per-version steps (schema 3 adds per-account batch times). Running again changes nothing. Both upgrades are **one way**: 0.1.0 refuses the new config keys and a database written by a newer schema. To go back, install 0.1.0 again, put the `.v1.bak` back as `checker.config.json`, and restore a copy of `checker.db` made before upgrading.

## Performance

0.2.0 removes the quadratic work in the scheduler and streams the CSV and the report. On the maintainer's Mac (Apple Silicon, Node 24.14), a five-app 100 000-row `check` stage went from 158 s to 29 s and produces the same result rows as 0.1.0 (the report is identical except for the six new threema/matrix columns), `doctor` from about 480 ms to about 70 ms in the macOS archive, and 300 000-row parsing uses about 19 % less memory. Machine, commands, before/after tables, the parallel-accounts simulation and how to reproduce them: [docs/performance.md](docs/performance.md).

## How it works

```mermaid
flowchart LR
    CSV[/"customers.csv"/] --> N["Detect column,<br/>normalise to E.164,<br/>de-duplicate"]
    N --> S["Scheduler / dispatcher<br/>batches, pacing, caps,<br/>cooldowns, resume"]
    S --> T["Telegram"] & W["WhatsApp"] & Z["Zalo"] & V["Viber"] & L["LINE"] & TH["Threema"] & M["Matrix"]
    S <--> DB[("SQLite results<br/>+ account state")]
    DB --> R[/"report.csv"/]
```

Each app has an adapter behind one small interface; an adapter logs in once (session stored privately under `data/sessions/<app>/<account>`) and then answers `yes` / `not_found` / `unknown` for a batch of numbers, or signals that the account is throttled or banned. The scheduler runs one dispatcher per app: it spreads batches over your accounts, enforces caps and cooldowns (a cap is reserved when a batch is sent), commits every batch to SQLite and never lets a failed lookup overwrite an earlier answer. Read more in [docs/architecture.md](docs/architecture.md).

## Per-app setup

| App | Guide | Effort |
| --- | --- | --- |
| Telegram | [docs/telegram-setup.md](docs/telegram-setup.md) | minutes (needs `api_id` / `api_hash` from <https://my.telegram.org/apps>) |
| WhatsApp | [docs/whatsapp-setup.md](docs/whatsapp-setup.md) | minutes (phone at hand for the pairing code) |
| Zalo | [docs/zalo-setup.md](docs/zalo-setup.md) | minutes (Vietnam numbers only) |
| LINE | [docs/line-setup.md](docs/line-setup.md) | minutes (useful mainly in HK/JP/KR/TW/TH) |
| Threema | [docs/threema-setup.md](docs/threema-setup.md) | minutes (a Threema Gateway ID and secret; Gateway is a paid service, lookup credit use not verified; people who linked a phone number only) |
| Matrix | [docs/matrix-setup.md](docs/matrix-setup.md) | minutes (a Matrix account; coverage depends on the identity server) |
| Viber | [docs/viber-setup.md](docs/viber-setup.md) | hours (Android emulator or rooted phone, `adb`, schema discovery) |

## Verification status

What has and has not been checked. Nothing here is a guarantee about live platforms.

| Area | Status |
| --- | --- |
| CSV parsing, phone normalisation, config validation and migration, scheduler and dispatcher, SQLite store and its migrations, report writer, run lock, file permissions, CLI end to end (with a test-only injected adapter) | Automated tests (`npm test`, over 1 700 tests); CI runs them on macOS and Ubuntu |
| Each adapter's error classification (yes / not_found / rate limit / ban) | Tested against **test doubles** of the third-party clients, and for Threema and Matrix against stubbed HTTP responses |
| Performance numbers in [docs/performance.md](docs/performance.md) | Measured with the offline bench harness (`npm run bench`) and fake adapters on one Mac; real platform latency is unknown |
| macOS arm64 archive: install, `doctor --deep`, offline `report`, reinstall, the upgrade from a 0.1.0 home, uninstall, minimum-OS load commands, no secrets or data shipped | `npm run release:verify` (checks V1-V20) on a development Mac. Not run on macOS 13.5 itself, on Intel Macs, or under Gatekeeper |
| **WhatsApp** against the live service | One real account linked with a pairing code; a handful of lookups returned the expected answers. QR linking on a real phone is unconfirmed (WhatsApp changed its flow in 2026-07; see the [guide](docs/whatsapp-setup.md)). No 20-number known-answer trial yet |
| **Zalo** against the live service | QR login completed once on the maintainer's machine; lookups not verified |
| **Telegram, Viber, LINE** against the live platforms | **Not verified** |
| **Threema, Matrix** against the live services | **Not verified.** Written from the published API documents; no Gateway account and no Matrix account was used, no real lookup was made. Whether Threema lookups use credits, and which Matrix identity servers still answer phone lookups, are open |
| Real rate limits, ban thresholds, sustainable throughput | **Unknown**; defaults are guesses |
| Menu translations other than English and Vietnamese | First-draft machine translation, not reviewed by native speakers |

Please run your own known-answer trial and open an issue with what you learn (without phone numbers or session data).

## FAQ

**Does it message or add the people it checks?** No. It sends no messages, calls, friend requests or invitations, and reads no names, avatars, ids, last-seen or profile data. Telegram's imported contacts are removed after each batch. (Threema returns a Threema ID and Matrix a Matrix ID for a match; the tool uses only the fact that one exists.)

**Why did I get `not_found` for someone who uses the app?** Privacy settings can hide a user from phone search (Telegram, Zalo, LINE); Viber's answer depends on contact sync; Threema and Matrix find only people who linked their number; a silent soft throttle can look like `not_found`. It is an observation, not proof.

**Which apps work where?** WhatsApp, Telegram, Threema and Matrix take numbers from any country (Threema and Matrix only if the person linked the number). Zalo checks Vietnam (+84) numbers only. LINE's phone search is meaningful only in HK / JP / KR / TW / TH.

**Can I use my personal number or my main account?** Please do not. Use dedicated, disposable accounts; they can be banned.

**Why does Telegram need my own `api_id`?** Telegram requires every program that logs in to carry keys that belong to its operator. The tool ships none and a shared pair would break Telegram's rules. Create yours at <https://my.telegram.org/apps>.

**Does a Threema or Matrix lookup tell someone about my list?** The number is sent to the operator in hashed form (Threema Gateway, or the Matrix identity server you chose). Threema's HMAC key is public, so anyone can recompute the hash of a known number. Do not use these apps for lists you may not disclose to those operators.

**Does it run on Windows or Linux?** The portable archive is macOS Apple Silicon only. From source it needs Node >= 22.18; CI runs the tests on Ubuntu. Windows is untested. Viber needs `adb` and an Android device or emulator.

**Will my 0.1.0 config and results still work?** Yes: they are upgraded automatically on first use, with a backup of the config. The upgrade is one way; see [Configuration](#configuration).

**Where is my data?** In `dataDir` (default `./data`; packaged app: `~/Library/Application Support/phone-app-checker`): login sessions (treat like passwords), a SQLite database of checked numbers, the run logs and reports you asked for. It refuses cloud-synced folders such as iCloud Drive or Dropbox. Delete it when done.

**Why is it GPL-3.0-or-later?** `baileys` (MIT) depends on `libsignal` (GPL-3.0), and the macOS archive bundles both, so the project as a whole is distributed under GPL-3.0-or-later. See [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

**Is this legal?** It depends on where you and the people you check are, what you do with the result, and whether they consented. See [docs/responsible-use.md](docs/responsible-use.md); this is not legal advice.

## Roadmap

Nothing below is promised; it is where help is most useful.

- Live pilots and known-answer trials for every app, with the results documented. Threema and Matrix are the least tested.
- Confirm WhatsApp QR linking on real phones after the 2026-07 flow change.
- Find which Matrix identity servers still answer phone lookups, and whether Threema lookups use credits.
- Run the portable archive on macOS 13.5 and on a clean Mac under Gatekeeper; consider code signing and notarisation.
- Intel macOS and Linux builds of the portable archive.
- Native-speaker review of the Indonesian, Malay, Korean and Chinese menu texts.
- Tuning of default pacing and `maxParallelAccounts` from real-world reports.

Apps that were looked at and rejected for lack of a lawful, practical lookup path (Signal, iMessage, KakaoTalk, WeChat and others) are listed in [docs/adding-an-adapter.md](docs/adding-an-adapter.md#apps-already-considered).

## Limitations

- Telegram, WhatsApp, Zalo and LINE depend on unofficial clients that follow protocols which can change without notice; lookups can break after any platform update. Baileys v7 is a release candidate.
- Platforms publish no limits; bans can happen at any time. Parallel accounts raise the exposure.
- Zalo: Vietnam only. LINE: a handful of regions. Viber: requires root and per-version SQL; no official API. Threema and Matrix: only people who linked a phone number can be found.
- Results are point-in-time observations; `not_found` is never proof of absence.
- Upgrading from 0.1.0 is one way; 0.1.0 cannot open an upgraded database.
- The macOS archive is for Apple Silicon only and is neither code-signed nor notarised.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Do **not** paste phone numbers, session files or `api_hash` values into issues. Want another app? Open an [app request](https://github.com/QuocHuannn/phone-app-checker/issues/new?template=new_app.yml) and read [docs/adding-an-adapter.md](docs/adding-an-adapter.md). Development: `npm ci`, `npm run typecheck`, `npm test`, `npm run smoke`, `npm run bench`; macOS release scripts: `npm run release:build`, `npm run release:verify`.

## Security

Report vulnerabilities privately through GitHub Security Advisories; see [SECURITY.md](SECURITY.md).

## License

Copyright (C) 2026 QuocHuannn and contributors. Licensed under the [GNU General Public License v3.0 or later](LICENSE) (`GPL-3.0-or-later`). Third-party components keep their own licences; see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md). The software is provided without warranty.
