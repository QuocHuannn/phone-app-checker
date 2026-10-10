# Matrix (Element) setup

The Matrix adapter asks an **identity server** whether a phone number is linked to a Matrix account. It uses the official [Identity Service API](https://spec.matrix.org/v1.19/identity-service-api/), no unofficial client, no new dependency and no Element app or phone: just HTTPS requests. It is **disabled by default**.

> **Not verified live.** This adapter was written from the Matrix specification and tested only against stubbed HTTP responses. No Matrix account was created and no real lookup was made while building it. Before relying on it, run a small trial on numbers whose answers you already know, and check the points under "Open questions" below.

## Read this first: coverage is low

A lookup only finds people who **linked their phone number to an identity server** (in Element: Settings > Account > Phone numbers, then "Share"). Most Matrix users never do that, and some identity servers stopped keeping such links for people on other homeservers (see the [matrix.org notice of 2019-07-19](https://matrix.org/blog/2019/07/19/privacy-changes-to-new-vector-identity-servers)). Current coverage is **unknown**.

Treat `yes` as reliable and `not_found` as only "no published link on this identity server", never as "no Matrix account". If you need a broad answer for a customer list, this app will mostly say `not_found`.

## What you need

- A **Matrix account** you control, with a username and password (a spare account is best). Accounts that only sign in with single sign-on (no password) cannot be used.
- The address of its **homeserver** (default `https://matrix.org`).
- An **identity server** (default `https://vector.im`, the one Element uses). It does not have to be the same as the homeserver; the account only has to be able to get an OpenID token from its homeserver.

## Enable and log in

1. Turn the app on by editing `checker.config.json` (menu item 5, "Check this Mac is ready (doctor)", shows where the file is):

   ```json
   {
     "apps": {
       "matrix": {
         "enabled": true,
         "options": { "homeserver": "https://matrix.org", "identityServer": "https://vector.im" }
       }
     }
   }
   ```

   Both addresses must start with `https://`. `http://` is refused: the password and the tokens must not travel in clear text.

2. Log in (menu item 2, "Log in an app account", or the command line):

   ```sh
   phone-app-checker login matrix --account <name>
   ```

   You are asked for the homeserver (Enter = the configured one), your username (`alice` or `@alice:matrix.org`) and your password. **The password is not shown while you type.**

What login does, in order:

1. Logs in to the homeserver with the password (`POST /_matrix/client/v3/login`).
2. Asks the homeserver for an OpenID token (`POST …/openid/request_token`).
3. Registers that token with the identity server (`POST /_matrix/identity/v2/account/register`), which returns an **identity token**.
4. Reads the lookup parameters (`GET /_matrix/identity/v2/hash_details`). If the identity server wants you to accept its **terms of service** first, the terms links are printed and you are asked `y/n`; only after a yes are they accepted (`POST /_matrix/identity/v2/terms`) and the step is repeated.
5. Saves the result and **logs the homeserver session out again**.

Saved in `credentials.json` in the account directory (mode `600`, directory mode `700`): `{ "identityServer", "identityToken", "lookupPepper" }`. **The password and the homeserver access token are never stored**, and neither is logged or printed. If any step fails, nothing is saved and an earlier working login stays as it was. Treat `data/` as secret and never commit it. `phone-app-checker doctor` warns when the file is missing or readable by other users.

## What a lookup does

For each number the adapter hashes the E.164 digits **without the leading `+`**, as the specification's "3PID Types" appendix defines the `msisdn` address, with the identity server's current pepper: `base64url(sha256("<digits> msisdn <pepper>"))`, unpadded. The specification's own example (`18005552067` with pepper `matrixrocks` gives `nlo35_T5fzSGZzJApqu8lgIudJvmOQtDaHtr-I4rU7I`) is part of the tests.

One `POST /_matrix/identity/v2/lookup` is made per batch. **A hashed number with a public pepper is a pseudonym, not protection.** Treat every lookup as sending the number to the identity server, and only check numbers you may process (see `docs/responsible-use.md`). Nothing is sent to the person.

## Result mapping

| Identity server answer | Status / signal |
| --- | --- |
| 200 and the number's hash is in `mappings` | `yes` |
| 200 and the hash is not in `mappings` | `not_found` |
| 200 without a `mappings` object | error (response not understood), **not** a status |
| 400 `M_INVALID_PEPPER` | `hash_details` is read again **once**, the numbers are re-hashed and the lookup is retried; a second failure is an error |
| 401 / `M_UNAUTHORIZED` | `AccountBanned` (log in again) |
| 403 `M_TERMS_NOT_SIGNED` | `AccountBanned` (log in again to read and accept the new terms) |
| 429 / `M_LIMIT_EXCEEDED` | `RateLimited`; waits for `retry_after_ms` (or a whole-number `Retry-After` in seconds) when given, otherwise for `rateLimitCooldownMs` |
| Other HTTP errors, network failure, timeout (30 s) | error; handled by the runner's error cooldown, never converted to `not_found` |
| Number that is not valid E.164 | left out of the batch, reported `unknown` |

Numbers from every country are checked; there is no region scope.

## Default pacing

| Setting | Default |
| --- | --- |
| `batchSize` | 1 |
| `dailyCap` | 100 |
| `minIntervalMs` / `jitterMs` | 5000 / 5000 |
| `rateLimitCooldownMs` | 6 hours |
| `errorCooldownMs` | 10 minutes |
| `maxParallelAccounts` | 1 |

These are **conservative guesses**: the specification marks `lookup` as not rate-limited and publishes no limit, but servers may still throttle. Raise `batchSize` gradually while watching for `RateLimited`.

## Open questions (not verified live)

1. Which identity servers still answer `msisdn` lookups in 2026?
2. Does `vector.im` accept new identity tokens for accounts on `matrix.org`, and does it keep phone links for them?
3. Do the identity server's terms allow checking a customer list?

If you find the answers in a pilot, please tell the maintainers (an issue without any numbers, passwords, tokens or sessions).
