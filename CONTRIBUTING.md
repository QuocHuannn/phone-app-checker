# Contributing

Thanks for your interest in phone-app-checker. Please read the [Code of Conduct](CODE_OF_CONDUCT.md) and [docs/responsible-use.md](docs/responsible-use.md) first: contributions that help people check numbers without consent, evade platform safeguards at scale, or harvest profile data will not be accepted.

## Ground rules

- **Never paste real phone numbers, session files, `api_id` / `api_hash`, or reports** in issues, pull requests, commits, tests or logs. Use synthetic numbers (`+84901234567`, `+84912345678`).
- Security problems: do not open a public issue; follow [SECURITY.md](SECURITY.md).
- Be honest about verification: if you could not test something against a live platform, say so in the pull request.

## Licence of contributions

The project is licensed under [GPL-3.0-or-later](LICENSE). By submitting a contribution you agree that it is licensed under GPL-3.0-or-later and that you have the right to submit it. We do not require a CLA or per-file headers; add a `Signed-off-by` line (`git commit -s`) if you want to state this explicitly (Developer Certificate of Origin). If you add a dependency, check its licence is GPL-3.0 compatible and run `npm run licenses` to refresh [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Getting set up

Requirements: Node.js >= 22.18 and npm. macOS is the primary platform; Linux is covered by CI.

```sh
git clone https://github.com/QuocHuannn/phone-app-checker.git
cd phone-app-checker
npm ci
npm run typecheck     # tsc --noEmit
npm test              # vitest (1 500+ tests, runs in an isolated HOME; takes a couple of minutes)
npm run smoke         # end-to-end demo with a test-only adapter
```

Tests never touch your real `~/Library/Application Support/phone-app-checker*` (see `tests/setup/`). The macOS release scripts (`npm run release:build`, `npm run release:verify`) need an Apple Silicon Mac and network access.

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Fork, branch from `main`, keep the change focused.
3. Follow the existing patterns: TypeScript run directly by Node (no build step, `erasableSyntaxOnly`), adapters behind the `Adapter` / `Session` interface in `src/types.ts`, errors classified as `RateLimited` / `AccountBanned`, phone numbers always masked in logs (`maskPhone`, `redactPhones`), private file modes for anything sensitive.
4. Add or update tests. Adapter tests replace only the third-party client (or `adb`) with test doubles; there is no fake mode at runtime.
5. Update the docs and [CHANGELOG.md](CHANGELOG.md) (under `## [Unreleased]`) when behaviour changes. If you changed the user-visible doctor or installer wording, check the tests that quote it from the install guides.
6. Run `npm run typecheck` and `npm test` before opening the pull request.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `test:`, `refactor:`).

## Good first contributions

- Live verification reports for Telegram, Zalo, LINE, Viber (what worked, what error codes you saw; no numbers).
- Native-speaker review of the Indonesian, Malay, Korean and Chinese texts in `src/i18n/`.
- Docs corrections, clearer setup guides, additional tests.
- Linux / Intel macOS packaging ideas (open an issue to discuss first).

## Releasing (maintainers)

Bump `version` in `package.json`, update `CHANGELOG.md`, run `npm run licenses`, commit, then tag `vX.Y.Z` and push the tag. The `release` workflow builds the macOS arm64 archive, runs `npm run release:verify`, and attaches the archive and its `.sha256` to a GitHub Release.
