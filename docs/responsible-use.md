# Responsible use

phone-app-checker tells you whether a phone number is registered on Telegram, WhatsApp, Zalo, Viber or LINE. Looking up whether a number has an account is a form of processing personal data, and doing it at scale against platforms that do not allow it carries real risk for you, for the accounts you use, and for the people whose numbers you check. Read this page before you run the tool.

This page is general information, **not legal advice**. Rules differ by country and change; you are responsible for knowing and following the ones that apply to you.

## The rules of the road

1. **Consent first.** Only check numbers of people who agreed to be contacted or checked, or where you have another lawful basis that you have assessed yourself. The tool does not and cannot verify consent. Do not check numbers you scraped, bought, guessed or generated.
2. **Purpose limitation.** Use the result for the purpose you collected the number for (for example: finding the channel a customer who asked to be reached prefers). Do not use it to track, profile, harass, stalk, discriminate against, pressure or spam anyone.
3. **Data minimisation.** Check only what you need. The tool stores each number, its status and a timestamp locally, and nothing else about the person. Delete the database and reports when you no longer need them (see [data and secrets](reference.md#data-and-secrets)).
4. **Keep it local and private.** The data folder holds live login sessions of your checking accounts and the numbers you checked. Do not commit, share, sync or upload it. Do not paste phone numbers, session files, `api_hash` values or reports into public issues, chats or logs.
5. **No contact, no side effects.** The tool never sends messages, calls, friend requests or invitations. Do not extend it, or combine it with other tools, to do so for people who did not ask for it.

## Privacy and data-protection law

Many countries regulate collecting and checking phone numbers of identifiable people. **Check your local law.** Examples of regimes that may apply, depending on where you and the people you check are located:

- Vietnam: Personal Data Protection Law (Law No. 91/2025/QH15) and its implementing decrees.
- European Union / EEA and UK: GDPR / UK GDPR.
- Singapore: PDPA (including the Do Not Call provisions). Malaysia: PDPA 2010.
- Indonesia: Personal Data Protection Law (Law No. 27/2022).
- Australia: Privacy Act 1988 and the Spam Act. New Zealand: Privacy Act 2020.
- South Korea: Personal Information Protection Act (PIPA).
- United States: a growing set of state privacy laws (for example California's CCPA/CPRA) plus federal rules on marketing contact.

Typical obligations include having a lawful basis (often consent), telling people what you do with their data, keeping it secure, limiting retention, honouring access and deletion requests, and rules for transferring data abroad. Marketing-contact rules may apply separately from data-protection rules. If in doubt, ask a qualified lawyer.

## Platform terms of service and account risk

- The tool talks to each platform through **unofficial, reverse-engineered clients** (Baileys, mtcute, zca-js, linejs) or, for Viber, by driving the real Viber app on an Android device. None of the five platforms offers a sanctioned way to do this, and **their terms of service probably forbid it**.
- The accounts you log in with can be rate-limited, restricted, or **permanently banned**, and so can the phone numbers behind them. Use dedicated, disposable SIMs and accounts, never a personal or business-critical number. Age new accounts with a few days of normal use first.
- The defaults are conservative guesses; platforms publish no limits. Start small, watch `phone-app-checker accounts`, and raise limits slowly.
- You, not the project, accept this risk by running the tool.

## Accuracy: what a result means

- A result is an **observation at a point in time**, not proof of identity, of an active account, or of consent.
- `not_found` does **not** mean the person has no account. Users can hide themselves from search by phone number (Telegram, Zalo, LINE), Viber's answer depends on contact sync, and a silent soft throttle on the platform side can look like `not_found`.
- **LINE** phone search is meaningful only in a few regions (Hong Kong, Japan, South Korea, Taiwan, Thailand); elsewhere `not_found` carries almost no information.
- **Zalo** is checked for Vietnamese (`+84`) numbers only.
- Before trusting a run, test with a small file of numbers whose answers you already know, per app.
- Verification status of each app is listed in the [README](../README.md#verification-status).

## Not affiliated

phone-app-checker is an independent project. It is **not affiliated with, endorsed by, or sponsored by** Telegram, WhatsApp / Meta, Zalo / VNG, Viber / Rakuten, or LINE / LY Corporation. All product names and trademarks belong to their owners and are used only to say which service a check is about.

## If something goes wrong

- A platform or a person asks you to stop: stop, delete the related data, and do not retry.
- A session file or `api_hash` leaked: log the device out in the app (Linked devices / Devices / Sessions), delete the account directory, and for Telegram regenerate the key at <https://my.telegram.org/apps>.
- You found a security problem in this project: see [SECURITY.md](../SECURITY.md) and report it privately.
