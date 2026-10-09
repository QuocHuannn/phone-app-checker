# Security policy

## Supported versions

Security fixes are made for the latest released version and the `main` branch only.

| Version | Supported |
| --- | --- |
| latest release (0.1.x) | yes |
| older releases | no |

## Reporting a vulnerability

**Do not open a public issue** for a security problem. Use GitHub's private vulnerability reporting:

1. Go to <https://github.com/QuocHuannn/phone-app-checker/security/advisories/new>.
2. Describe the problem, the affected version or commit, and how to reproduce it. A minimal proof of concept helps.

You will get an acknowledgement as soon as a maintainer can look at it; this is a small volunteer project, so please allow several days. We will work with you on a fix and a coordinated disclosure, and credit you in the advisory if you want.

**Never include real phone numbers, session files, `api_hash` values, tokens or reports in a report.** Synthetic data is enough to explain a bug.

## What is in scope

- Leaking or mishandling of secrets and personal data by the tool: login sessions, `api_id` / `api_hash`, checked phone numbers (logs, reports, temp files, file modes, symlink / path handling, cloud-synced folders).
- Command or SQL injection, path traversal, or unsafe archive/installer behaviour in the macOS release scripts (`install.sh`, `uninstall.sh`, `build-release.sh`, `verify-release.sh`).
- Terminal-escape or spreadsheet-formula injection through a malicious CSV.
- A tampered or mis-built release archive.

Out of scope: vulnerabilities in third-party libraries that are already public and not exploitable through this tool (report them upstream; Dependabot tracks them here), account bans or rate limits imposed by messaging platforms, and misuse of the tool against people who did not consent (see [docs/responsible-use.md](docs/responsible-use.md)).

## Handling session files and keys

The data folder (`./data`, or `~/Library/Application Support/phone-app-checker` for the packaged app) contains **live login sessions** of your checking accounts: anyone who holds them can act as those accounts. The tool creates them with owner-only permissions (directories 700, files 600) and refuses cloud-synced folders. You should:

- never commit, upload, share or back up `data/` or `checker.config.json` to a synced or shared location;
- treat `api_hash` like a password;
- if a session or key may have leaked: log the device out in the app (WhatsApp *Linked devices*, Telegram *Devices*, Zalo and LINE *login devices*), delete the account folder under `data/sessions/`, and for Telegram regenerate the key at <https://my.telegram.org/apps>;
- verify the SHA-256 of any release archive before installing it.

The repository's `.gitignore` is an allow-list so that `data/`, `*.csv`, `*.db` and `checker.config.json` cannot be committed by accident.
