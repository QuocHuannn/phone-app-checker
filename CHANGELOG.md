# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project logo and brand assets in `docs/assets/` (SVG logo, light and dark lockups, one-colour marks, favicon and app icons, GitHub social preview) and a short usage guide in `docs/brand.md`.

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

[Unreleased]: https://github.com/QuocHuannn/phone-app-checker/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/QuocHuannn/phone-app-checker/releases/tag/v0.1.0
