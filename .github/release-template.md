## Read this first

- **Consent only.** Use phone-app-checker only for numbers of people who agreed to be contacted or checked. The tool cannot verify consent. Check your local privacy law first; this is not legal advice. Full text: [docs/responsible-use.md](https://github.com/QuocHuannn/phone-app-checker/blob/main/docs/responsible-use.md).
- **Accounts can be banned.** Telegram, WhatsApp, Zalo, LINE and Viber are reached with unofficial methods that their terms probably forbid. Use dedicated, disposable accounts.
- **Threema and Matrix send a hash of the number to a third party** and are disabled by default.
- **Not verified live.** Only WhatsApp has been tried against the real service (one account, a few lookups). Telegram, Zalo, Viber, LINE, Threema and Matrix are tested with doubles only. The archive was built and verified on a development Mac; it was not run on macOS 13.5, on Intel Macs or under Gatekeeper, and it is neither code-signed nor notarised.
- **Verify the download.** Check the `.sha256` before you install: `shasum -a 256 -c <file>.sha256`.
- **Upgrading from an older version is one way.** The first run upgrades your config and database; keep a copy of `checker.db` if you may want to go back. See "Upgrading" below.

