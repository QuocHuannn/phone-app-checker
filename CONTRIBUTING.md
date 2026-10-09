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
npm test              # vitest (1 700+ tests, runs in an isolated HOME; takes a couple of minutes)
npm run smoke         # end-to-end demo with a test-only adapter
npm run check         # typecheck + licences check + tests in one go
```

Tests never touch your real `~/Library/Application Support/phone-app-checker*` (see `tests/setup/`). The macOS release scripts (`npm run release:build`, `npm run release:verify`) need an Apple Silicon Mac and network access.

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Fork, branch from `main`, keep the change focused.
3. Follow the existing patterns: TypeScript run directly by Node from a source checkout (`erasableSyntaxOnly`; `npm run build` compiles it for the release archive), adapters behind the `Adapter` / `Session` interface in `src/types.ts`, errors classified as `RateLimited` / `AccountBanned`, phone numbers always masked in logs (`maskPhone`, `redactPhones`), private file modes for anything sensitive. The app list comes from `APPS` in `src/types.ts`: never hard-code a list or count of apps. To add an app, read [docs/adding-an-adapter.md](docs/adding-an-adapter.md) and open an [app request](https://github.com/QuocHuannn/phone-app-checker/issues/new?template=new_app.yml) first.
4. Add or update tests. Adapter tests replace only the third-party client (or `adb`) with test doubles; there is no fake mode at runtime.
5. Update the docs and [CHANGELOG.md](CHANGELOG.md) (under `## [Unreleased]`) when behaviour changes. If you changed the user-visible doctor or installer wording, check the tests that quote it from the install guides.
6. Run `npm run typecheck` and `npm test` before opening the pull request. Shell scripts must stay clean under `shellcheck -S warning` (CI runs it) and work with the bash 3.2 that ships with macOS.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `test:`, `refactor:`).

## Good first contributions

- Live verification reports for every app, most of all Threema and Matrix (what worked, what error codes you saw; no numbers).
- Native-speaker review of the Indonesian, Malay, Korean and Chinese texts in `src/i18n/`.
- Docs corrections, clearer setup guides, additional tests.
- Linux / Intel macOS packaging ideas (open an issue to discuss first).

## Repository settings (maintainers)

Set by the repository owner in GitHub, not by files in this repository:

- **Branch protection on `main`:** require a pull request, and require the status checks `test (macos-14, node 24)`, `test (ubuntu-24.04, node 24)`, `test (ubuntu-24.04, node 22.18.0)`, `npm audit (production)` and `shellcheck` to pass. A single maintainer can keep the admin bypass. Do not allow force pushes or deletion of `main`.
- **Tag ruleset:** restrict creation, update and deletion of tags matching `v*` to maintainers. A published tag is never moved: if an archive is bad, ship the next patch version.
- Squash or merge commits are both fine; `delete_branch_on_merge` is on. Secret scanning, push protection and Dependabot security updates stay enabled. Hold Dependabot merges while a release is being cut.
- The `app-request` label is used by the app-request issue template.

## Releasing (maintainers)

The release path is: pull request, green CI, merge to `main`, annotated tag `vX.Y.Z` on that commit, tag workflow, check the published bytes. The `release` workflow refuses a tag that is not on `main` or that does not match `package.json`, runs the typecheck, licence check and the full tests, builds the archive on `macos-14`, runs `npm run release:verify`, and attaches the archive and its `.sha256` to a GitHub Release whose notes are the `CHANGELOG.md` section for that version plus the consent block in [.github/release-template.md](.github/release-template.md). It uses only the automatic `GITHUB_TOKEN`; never add secrets to it.

**Before you start.** All feature work is merged; CI is green on the exact commit you will tag; `npm audit --omit=dev` reports 0 vulnerabilities (the build fails on any advisory); for a long local job start the sleep guard first (`caffeinate -dimsu -t 43200 &`). The Node pin in `scripts/build-release.sh` (`NODE_VERSION`, `NODE_SHA256`) only changes with its docs.

**Commands** (from the repository root; replace `X.Y.Z`):

```sh
git switch main && git pull --ff-only origin main
git status --short                                   # must be empty
gh run list --workflow CI --branch main --limit 1 \
  --json conclusion,headSha,status --jq '.[0]'       # conclusion "success" and headSha == git rev-parse HEAD

npm version X.Y.Z --no-git-tag-version --ignore-scripts   # package.json and package-lock.json
grep -rn "0\.1\.0" README.md docs SECURITY.md        # replace stale version literals (keep history and upgrade notes)
# CHANGELOG.md: rename [Unreleased] to [X.Y.Z] - date, add an empty [Unreleased], update the compare links
npm run licenses && npm run licenses:check           # only if dependencies changed

npm run check                                        # typecheck, licences, tests
npm run smoke
shellcheck -S warning $(git ls-files 'scripts/*.sh' 'release/*.sh')
npm run release:build && npm run release:verify      # optional local archive proof (Apple Silicon, network)

git add -A && git commit -s -m "chore(release): vX.Y.Z"
git push origin main                                 # or through a pull request
gh run watch "$(gh run list --workflow CI --branch main --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status

git tag -a vX.Y.Z -m "phone-app-checker X.Y.Z"
git push origin vX.Y.Z                               # starts the Release workflow
gh run watch "$(gh run list --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId')" --exit-status
```

**Check the published bytes:**

```sh
mkdir -p /tmp/pac-release && cd /tmp/pac-release
gh release download vX.Y.Z -p 'phone-app-checker-X.Y.Z-macos-arm64.tar.gz' -p 'phone-app-checker-X.Y.Z-macos-arm64.tar.gz.sha256' --clobber
shasum -a 256 -c phone-app-checker-X.Y.Z-macos-arm64.tar.gz.sha256
```

**If the release job fails after the build** (for example the attach step): download the CI artifact with `gh run download <run-id> -n phone-app-checker-X.Y.Z-macos-arm64` and create the release by hand with `gh release create vX.Y.Z --verify-tag --notes-file <file> <archive> <archive>.sha256`. Never upload a local `dist/` build; the release must come from the CI artifact or a fresh build of the tagged commit.

**Rules.** A `v*` tag must equal `v` plus the `package.json` version (a release candidate tag such as `v0.2.0-rc1` is refused). Never move or reuse a published tag. Network failures in `npm ci` or the Node download: re-run the job. A release is a draft until the checksum check above passes.
