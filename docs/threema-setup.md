# Threema setup

The Threema adapter asks the **official Threema Gateway API** whether a phone number is linked to a Threema ID. It uses no unofficial client, no new dependency and no Threema app or phone: just HTTPS requests. It is **disabled by default**.

> **Not verified live.** This adapter was written from the published Gateway documentation and tested only against stubbed HTTP responses. No Gateway account was created and no real lookup was made while building it. Before relying on it, run a small trial on numbers whose answers you already know, and check the points under "Open questions" below.

## What you need: a Gateway ID

A **Gateway ID** is a Threema Gateway account identity: `*` followed by seven capital letters or digits (for example `*ABCDEFG`). It comes with an **API secret**. You get both by signing up at <https://gateway.threema.ch>. Sign-up is free, with no recurring fee. Sending messages through the Gateway costs credits (from CHF 0.01 per message); this tool never sends messages.

The Gateway ID is **not** your personal Threema ID. Use a Gateway account you control.

## Costs and credits

- The documented lookup endpoint lists no "out of credits" answer, so lookups are probably not billed. That has **not been confirmed**: compare the credit balance on the Gateway dashboard before and after a small trial.
- If the Gateway answers HTTP 402 (no credits), the account is treated as unusable until you add credits, and the run says why.
- Threema requires manual approval for bulk lookups. The adapter makes one request per number and does not try to get around that.

## Enable and log in

1. Turn the app on by editing `checker.config.json` (menu item 5, "Check this Mac is ready (doctor)", shows where the file is):

   ```json
   { "apps": { "threema": { "enabled": true } } }
   ```

2. Log in (menu item 2, "Log in an app account", or the command line):

   ```sh
   phone-app-checker login threema --account <name>
   ```

   You are asked for the Gateway ID, then for the secret. **The secret is not shown while you type.** Both are checked with a `GET /credits` request, which looks nothing up. If Threema rejects them (HTTP 401), nothing is saved and an earlier working login stays as it was.

Credentials are saved to `credentials.json` in the account directory (mode `600`, directory mode `700`) as `{ "gatewayId", "secret" }`. Treat `data/` as secret and never commit it. `phone-app-checker doctor` warns when the file is missing or readable by other users.

The Gateway takes the ID and secret as URL parameters, so a request URL is a credential. The adapter never logs or prints a URL, and error messages never contain the secret.

## What a lookup does

For each number the adapter computes `HMAC-SHA256(key, number without "+")` with the key Threema publishes and calls `GET /lookup/phone_hash/<hash>`. The phone number itself is not in the request. **The key is public, so the hash is a pseudonym, not protection:** anyone can reproduce the hash for any number. Treat every lookup as sending the number to Threema, and only check numbers you may process (see `docs/responsible-use.md`).

Nothing is sent to the person.

## Result mapping

| Gateway answer | Status / signal |
| --- | --- |
| 200 with a Threema ID (8 characters, with or without a leading `*`) | `yes` |
| 200 with anything else | error (response not understood), **not** `yes` |
| 404 | `not_found` |
| 401 (bad Gateway ID or secret) | `AccountBanned` (log in again) |
| 402 (no credits) | `AccountBanned` with a "no credits" message |
| 429 | `RateLimited`; waits for `Retry-After` seconds when the header is a whole number, otherwise for `rateLimitCooldownMs` |
| 400, 5xx, network failure, timeout (30 s) | error; handled by the runner's error cooldown, never converted to `not_found` |
| Number that is not valid E.164 | left out of the batch result, reported `unknown` |

Numbers from every country are checked; there is no region scope.

## `not_found` is not proof of "no Threema account"

Threema matches a phone number only for people who **chose to link a phone number to their Threema ID**. Linking is optional, and many users never do it. A `not_found` therefore means **"no Threema ID linked to this number"**. Expect many `not_found` answers for people who do use Threema. `yes` is reliable; `not_found` is only a lower bound.

## Default pacing

| Setting | Default |
| --- | --- |
| `batchSize` | 1 |
| `dailyCap` | 100 |
| `minIntervalMs` / `jitterMs` | 5000 / 5000 |
| `rateLimitCooldownMs` | 1 hour |
| `errorCooldownMs` | 10 minutes |
| `maxParallelAccounts` | 1 |

These are **conservative guesses**: Threema publishes no lookup rate limit. Raise them gradually while watching for `RateLimited`.

## Open questions (not verified live)

1. Do lookups deduct Gateway credits?
2. Do the Gateway terms allow checking a customer list?
3. Is a particular Gateway type (Basic or End-to-End) required for lookups?

If you find the answers in a pilot, please tell the maintainers (an issue without any numbers, secrets or sessions).
