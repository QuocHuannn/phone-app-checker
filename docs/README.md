# Setup guides

Start with the [project README](../README.md) (overview and quick start) and [responsible-use.md](responsible-use.md). The [reference](reference.md) documents `login`, `check`, `report`, `accounts`, configuration and data handling in depth; [architecture.md](architecture.md) explains how it works; [performance.md](performance.md) has the measured speed and memory numbers; [adding-an-adapter.md](adding-an-adapter.md) is for contributors who want to add an app. Non-developers on a Mac using the packaged download: [install-macos.md](install-macos.md) (Vietnamese: [install-macos.vi.md](install-macos.vi.md)). Then set up each app you want to check. Logo and colours: [brand.md](brand.md).

> **Packaged app:** the guides below show `npm run cli -- <command>`. In the macOS download, run the same commands as `phone-app-checker <command>` (for example `phone-app-checker login telegram --account tg1`); `data/` and `checker.config.json` then live in `~/Library/Application Support/phone-app-checker`.

| App | Guide | Effort | Needs |
| --- | --- | --- | --- |
| Telegram | [telegram-setup.md](telegram-setup.md) | minutes | `api_id` / `api_hash`, SIM, terminal |
| WhatsApp | [whatsapp-setup.md](whatsapp-setup.md) | minutes | SIM + phone for QR / pairing code |
| Zalo | [zalo-setup.md](zalo-setup.md) | minutes | Zalo account + app to scan QR (Vietnam numbers only) |
| LINE | [line-setup.md](line-setup.md) | minutes | LINE account; useful mainly for HK/JP/KR/TW/TH |
| Threema | [threema-setup.md](threema-setup.md) | minutes | a Threema Gateway ID + secret (Gateway is a paid service; whether lookups use credits is not verified); finds only people who linked a phone number; **not verified live** |
| Matrix | [matrix-setup.md](matrix-setup.md) | minutes | a Matrix account; finds only people who linked a phone number to an identity server; **not verified live** |
| Viber | [viber-setup.md](viber-setup.md) | hours | Android emulator or rooted phone, `adb`, schema discovery with [`scripts/viber-discover-schema.sh`](../scripts/viber-discover-schema.sh), three SQL queries |

## Operating rules for every app

1. **Dedicated accounts only.** The Telegram, WhatsApp, Zalo, LINE and Viber adapters use unofficial clients; the account can be throttled, restricted or banned. Threema and Matrix use official lookup interfaces, but a lookup still sends a hash of the number to a third party. Do not use a personal or business-critical number.
2. **Age new accounts** with a few days of normal use before bulk checking.
3. **Start low.** Keep the default pacing and `maxParallelAccounts: 1`, run a ~20-number staff file with known answers per app, compare, then raise `batchSize` / `dailyCap` step by step while watching `npm run cli -- accounts` (it shows each account's batch time). Raise `maxParallelAccounts` only when batches are slow compared with the pacing pause.
4. **`not_found` is not "does not use the app".** Privacy settings hide people from phone search, and Threema and Matrix find only people who linked a phone number.
5. **A `DISABLED` account needs a human.** Fix the cause (check the phone, re-link), then `login <app> --account <name>` or `account-reset <app> <name>`.
6. **Keep `data/` private** and on a local, non-synced disk (not iCloud/Dropbox/network): it contains live sessions of the checking accounts and the checked numbers. The app refuses an app home or `dataDir` that is, or lies inside, iCloud Drive (`~/Library/Mobile Documents`, `~/iCloud Drive`), `~/Library/CloudStorage/*`, `~/Dropbox*`, `~/Google Drive*`, `~/OneDrive*`, `~/Box`, `~/Box Sync` or `~/Box Drive`. Keep customer CSVs in a dedicated local folder too, not `Documents`/`Desktop`.
7. **Re-validate after library or app updates.** Baileys, zca-js, linejs and mtcute follow unofficial protocols; Viber's database schema changes between app versions.

## Live-account smoke checklist (cannot be automated)

Run once per app after setup, with a staff CSV whose registration state is known for each app:

1. `npm run cli -- login <app> --account <name>` succeeds; `npm run cli -- accounts` lists it as `ready`.
2. `npm run cli -- check staff.csv --apps <app> --out staff-report.csv --no-wait` finishes without `DISABLED` / `cooling down`, **and without the `INCOMPLETE` banner** (if it is shown, fix the reason and re-run until it is gone: the report is not final).
3. Known registered numbers are `yes`, known unregistered numbers are `not_found` (allow for privacy-hidden users), and their `<app>_stale` cell is `no`. Record discoverable and privacy-hidden accounts separately and count `unknown` as unmeasured coverage; do not quote one overall accuracy figure. A `yes` is an observation at `<app>_checked_at`, not proof of identity or of an active account.
4. Kill the run with Ctrl-C midway and run again: already answered numbers are not asked again.
5. Telegram only: after the run, the checking account's contact list is empty. Viber only: no `phone-app-checker` contacts remain on the device.
