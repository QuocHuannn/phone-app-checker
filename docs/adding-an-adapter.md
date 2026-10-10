# Adding an adapter

How to add a messaging app to phone-app-checker. Read [responsible-use.md](responsible-use.md) and [CONTRIBUTING.md](../CONTRIBUTING.md) first: an adapter must not send anything to the person, must not read or store profile data, and must not need a consent bypass.

The two newest adapters are the best templates: [`src/adapters/threema.ts`](../src/adapters/threema.ts) (plain HTTPS, credentials file) and `src/adapters/matrix.ts` (plain HTTPS, multi-step login). Their setup guides, [threema-setup.md](threema-setup.md) and [matrix-setup.md](matrix-setup.md), show the structure a guide should have.

## Before you write code

1. **Is there a lawful, practical lookup path?** Prefer an official API. An app that has no phone lookup, or only a self-service "who can find me" setting, is not a candidate. Open an [app request](https://github.com/QuocHuannn/phone-app-checker/issues/new?template=new_app.yml) first so the approach can be agreed.
2. **Licence.** A new dependency must be GPL-3.0-or-later compatible. Prefer none: `fetch` and `node:crypto` were enough for Threema and Matrix.
3. **What does a lookup disclose?** If the number (or a hash of it) goes to a third party, say so in the setup guide and in [responsible-use.md](responsible-use.md).
4. **What does `not_found` mean?** Write it down. For Threema and Matrix it means "not linked", which is much weaker than "no account".

## The interface

`src/types.ts` defines `Adapter` (`login`, `open`) and `Session` (`check`). A session answers `yes` or `not_found` for the numbers it could check and leaves the rest out (they stay `unknown`). Signal throttling with `RateLimited` (optionally with a wait time) and an unusable account with `AccountBanned`; both may carry the partial answers already obtained. Anything else is a plain `Error`, which the scheduler handles with `errorCooldownMs`. Never convert an error into `not_found`.

## Touchpoints

**Enforced by the compiler** (a missing entry does not compile):

| File | What to add |
| --- | --- |
| `src/types.ts` | the name in `APPS` (the single source of truth for the app list) |
| `src/adapters/<app>.ts` | the adapter (new) |
| `src/adapters/index.ts` | `APP_SCOPE` entry and the `loadAdapter` case |
| `src/config.ts` | `DEFAULT_APPS` entry: `enabled: false`, pacing, `maxParallelAccounts: 1` |
| `src/doctor.ts` | `ADAPTER_PACKAGE` entry (`undefined` for a first-party adapter with no package) |
| `src/menu.ts` | `QR_MAX_MODULES` entry (`0` when the login shows no QR code) |
| `src/i18n/{en,vi,id,ms,ko,zh}.ts` | every new message key in all six catalogs (`satisfies Catalog`) |
| `tests/scheduler-soak.test.ts` | the `PACING` entry (or fall back to `DEFAULT_APPS`) |

**Not enforced, easy to forget:**

| File | What to add |
| --- | --- |
| `src/menu.ts` | `LOGIN_HINTS` entry (a `Partial`) and its message key |
| `checker.config.example.json` | the app block, `enabled: false` |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | the app in the dropdown |
| `src/csv.ts` | optional `HEADER_HINT`, so a column titled with the app's name is detected |
| `src/doctor.ts` | a credentials check (file present, mode 600) if the adapter keeps one |
| `docs/<app>-setup.md` | the setup guide, including "not verified live" if you could not test it |
| `README.md`, `docs/README.md`, `docs/reference.md`, `docs/responsible-use.md` | feature and per-app tables, verification status, third-party disclosure |
| `CHANGELOG.md` | an `Added` entry under `## [Unreleased]` |
| `tests/i18n.test.ts` | the token list only if a message must keep a literal |

**Already derived from `APPS`, no edit needed:** the report columns and the `summarize()` counts, `scripts/build-release.sh` (load gate) and `scripts/verify-release.sh` (doctor rows), and the shared test helpers in `tests/helpers/report-rows.ts`. Do not add a hard-coded list or count of apps anywhere; derive it from `APPS`.

**Config and database migrations.** A new optional config key with a default needs no migration. Renaming or removing a key needs a step in the `CONFIG_STEPS` list in `src/config.ts`; a database change needs a step in the `migrate()` ladder in `src/store.ts` and a fixture test with existing rows. Both ladders are one way; document the effect in the CHANGELOG "Upgrading" paragraph.

## Credentials and logs

- Keep credentials in the account directory (`data/sessions/<app>/<account>`, mode 700) and write them with a temporary file, `chmod 600` and an atomic rename.
- Never log a token, a secret, a password or a URL that carries one. Mask numbers with `maskPhone` / `redactPhones`. A request URL that holds a credential is a credential.
- A failed login must save nothing and leave an earlier working login alone.

## Pacing defaults

Pick conservative defaults and document them as guesses (platforms publish no limits). Start from `batchSize: 1`, a `dailyCap` of 100 or less, a `minIntervalMs` of seconds, and `maxParallelAccounts: 1`. If the app has a single device or session (Viber), the dispatcher must be forced to 1 and a higher config value rejected.

## Tests

- Replace only the third-party client, `fetch` or `adb` with a double; there is no fake mode at runtime. Use `vi.stubGlobal('fetch', ...)` for HTTP adapters.
- Cover every status mapping (`yes`, `not_found`, rate limit, ban, other errors), the login paths including a failed one (nothing saved), the file mode of saved credentials, and that no secret or full number reaches the logs.
- Use `tests/setup/isolate-home.ts` isolation and never write into the repo `data/`.
- Run `npm run typecheck`, the adapter's test file, then the full `npm test`. After the first adapter-count change also run `npm run release:build && npm run release:verify`: the bundle must load the new adapter under the pinned Node, and any new native module must have a minimum macOS of 13.5 or lower.
- `npm run licenses` regenerates `THIRD_PARTY_LICENSES.md` if a dependency was added; CI runs `npm run licenses:check`.

## Apps already considered

Looked at and rejected, so nobody repeats the work (sources and details in the maintainers' research notes; the reasons were checked on 2026-10-10):

| App | Why not |
| --- | --- |
| iMessage / FaceTime | no public lookup; unofficial paths need SIP disabled or send your numbers to a vendor |
| Google Messages (RCS) | no lookup API; the documented check is for your own device |
| KakaoTalk | no phone lookup API; the friends API is for consenting friends only |
| WeChat | no API; phone search is a user setting |
| Facebook Messenger, Instagram, Snapchat, TikTok | no API; contact-sync friend finding or private-API wrappers only |
| Microsoft Teams | directory lookup inside a tenant only |
| Skype | retired in 2025 |
| Truecaller | no consumer status lookup |
| Botim, imo | partner API only / in-app search only |
| Discord | automated user accounts are prohibited |
| Session, Wire | no phone-number identity or lookup |
| Kik | shut down |
| Signal | possible with `signal-cli`, but it needs a Java runtime and a legal review of bundling its AGPL-3.0 native library in a GPL-3.0-or-later archive; kept as a spike, not shipped |
