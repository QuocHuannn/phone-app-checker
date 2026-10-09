# Telegram setup

The Telegram adapter logs in as a real user account over MTProto (via
[mtcute](https://mtcute.dev)) and asks Telegram to resolve each phone number by temporarily
importing it as a contact. It never sends messages and never reads names, usernames, user
ids or avatars.

> This is an unofficial-client technique. Telegram may throttle or ban the account used
> for checking. Use a dedicated SIM/account you can afford to lose, not a personal one.

## 0. Why there is a QR code only after the keys, and why there are keys at all

Telegram requires **every program that logs in to a Telegram account** to identify itself with an `api_id` and an `api_hash`. They are free, belong to the person who creates them, and are tied to that person's phone number. A shared pair (one shipped inside this tool) would break Telegram's rules and put every user's accounts at risk of bans, so the tool deliberately does **not** include one: each operator makes their own, once.

The login is therefore three steps, shown up front by the menu:

| Step | What happens |
| --- | --- |
| 1/3 Get your free Telegram API keys (one-time) | You create the keys on <https://my.telegram.org/apps>. The menu can open the page for you (macOS, only after you answer yes). |
| 2/3 Save the keys | You paste the `api_id` and `api_hash`; the menu saves them in the config file. |
| 3/3 Scan the QR code (or enter phone + code) | The QR code appears here, right after the keys are saved. |

If the keys are already saved the menu says `API keys found` and goes straight to step 3/3.

## 1. Get API credentials

1. Sign in at <https://my.telegram.org/apps> with the checking account's phone number (Telegram sends a code to the Telegram app).
2. Fill the form: **App title** and **Short name** can be anything (for example `Checker` and `checker1`), **Platform** `Other`, leave URL and Description empty, click **Create application**. Copy **api_id** (integer, the short number) and **api_hash** (32 hex characters, the long code below it). If the page only shows an error, try again later or from another network: that is Telegram's page, not this tool.
3. Provide them to the CLI, either way:

```sh
export TELEGRAM_API_ID=1234567
export TELEGRAM_API_HASH=0123456789abcdef0123456789abcdef
```

or in `checker.config.json`:

```json
{ "apps": { "telegram": { "options": { "apiId": 1234567, "apiHash": "0123456789abcdef0123456789abcdef" } } } }
```

Config options win over environment variables. `api_hash` is a secret: do not commit it.

## 2. Log in

Easiest: run `phone-app-checker`, choose **2 (log in) → Telegram**. If `api_id` / `api_hash` are missing the menu shows the three steps and the reason, prints the address, tells you what to type in the form, offers to open the page (only on a terminal, only that one address, only after you answer yes), asks for the `api_id` (digits only) and the `api_hash` (32 hex characters, **shown only as mask characters while you type and never printed back**), validates them with a friendly message for the usual mistakes (hash typed as id and the reverse, wrong length), and saves them in the config file (atomic write, mode 600, every other setting kept). Type `b` (or press Enter) at any of those questions to go back. Then it asks how to log in. Or directly:

```sh
npm run cli -- login telegram --account tg1 --method qr   # QR code
npm run cli -- login telegram --account tg1               # phone number + login code
```

**QR code** (`--method qr`, mtcute `start({ qrCodeHandler })`): scan with the Telegram app on the phone, *Settings > Devices > Link Desktop Device*. Telegram issues a new login token about every 30 seconds; each one is drawn (replacing the previous code, marked `New QR code (#n)`). If the account has a two-step password you are asked for it after the scan (**not echoed**). If nobody scans within 5 minutes the login ends with an error.

After a successful login the screen says which account was linked (display name and a **masked** phone number, for example `Telegram account linked: An Nguyen (+8490****567).`); the session itself is never shown.

**When Telegram says no**, the message is one plain sentence with what to do next:

| Telegram says | The tool says |
| --- | --- |
| `FLOOD_WAIT_n` | wait n s / min / h before trying again; nothing is wrong with the account |
| `PHONE_MIGRATE_n` | Telegram is moving the number to another server; run the login again |
| `SESSION_PASSWORD_NEEDED` | the account has a two-step password; run the login again and type it (not shown) |
| `PHONE_NUMBER_INVALID` | use the international format, for example `+84901234567` |
| `PHONE_CODE_INVALID` / `PHONE_CODE_EXPIRED` | the code is wrong / expired; check the latest message or log in again |
| `PASSWORD_HASH_INVALID` | the two-step password is wrong |
| `API_ID_INVALID` | Telegram rejected the `api_id` / `api_hash`; copy both again from my.telegram.org/apps and replace the saved ones (below) |
| `PHONE_NUMBER_BANNED`, `USER_DEACTIVATED*` | Telegram does not let this number log in |
| `PHONE_NUMBER_FLOOD` | too many attempts; wait a few hours |
| anything else | `Telegram refused the request (<CODE>)`, with the code, and a pointer here |

To **replace saved keys**, edit `apps.telegram.options.apiId` / `apiHash` in the config file (the menu printed its path when it saved them: `api_id and api_hash saved in <path>`), or remove both values so the menu asks again, then log in again.

**Phone number + code** (default without `--method`) prompts in the terminal for:

1. the account's phone number in international format (`+84...`) (shown as you type),
2. the login code Telegram sends (in-app message or SMS) (**not echoed**),
3. the two-step verification password, only if the account has one (**not echoed**).

Ctrl-C (or Ctrl-D) at a prompt cancels the login and restores the terminal; a first login that
is cancelled or fails removes its half-created account directory.

Only session material is saved, to `data/sessions/telegram/tg1/session.sqlite` (files set to
mode 600 inside a mode 700 directory). Anyone with that file has full access to the Telegram
account: keep `data/` out of git and backups you do not control.

To use several accounts, repeat with different `--account` names. To re-login after a
`logged out` warning, run the same command again.

## 3. How a check works

For every batch the adapter:

1. calls `contacts.importContacts` with the batch numbers, each tagged with a unique
   `client_id`; placeholder names (`chkN`) are used because Telegram requires one;
2. maps results:

| Telegram response | Status |
|---|---|
| number returned in `imported` | `yes` |
| `client_id` listed in `retry_contacts` | `unknown`, and the account gets a rate-limit cooldown |
| number not returned | `not_found` |
| `FLOOD_WAIT_X` | rate-limited for X seconds (numbers stay `unknown`) |
| `PEER_FLOOD`, `AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`, `USER_DEACTIVATED*`, any HTTP-401-class error | account marked banned/logged out; re-login required |

3. deletes the imported contacts again with `contacts.deleteByPhones`, also when the import
   call failed part-way, so the account's address book stays empty. If deletion fails
   the CLI logs a warning with masked numbers; check the account's contacts manually
   after a pilot run.

Phone numbers appear in logs only masked (`+8490****567`). Telegram user ids and profile
data returned by the API are discarded, and **not** cached on disk: mtcute normally stores
every user object it receives in the `peers` table of `session.sqlite`, so this adapter
replaces that cache with a non-persistent one (credentials stay on disk, customer profiles
never do) and runs without an update loop.

**Sessions created by an earlier version** may still hold cached customer profiles. No action
is needed: the next `login` or `check` deletes every row of `peers` from the session file
before opening it, vacuums the file so the profile bytes do not linger in free pages, and
logs `removed N cached peer profile(s)`. To do it by hand: close the CLI, then
`sqlite3 data/sessions/telegram/<account>/session.sqlite 'PRAGMA secure_delete=ON; DELETE FROM peers; VACUUM;'`.

## 4. Limits and caveats

- **`not_found` is not proof that a person has no Telegram.** Users can set
  *Settings → Privacy → Phone Number → Who can find me by my number → My Contacts*;
  such accounts are not returned by `importContacts`. Treat `not_found` as "could not be
  found by number", i.e. a possible false negative. `yes` means Telegram resolved the number at
  that time: an observation, not proof of identity, ownership or an active account.
- **Throttling.** Telegram silently stops resolving numbers once an account imports too many
  (`retry_contacts`). Those numbers are `unknown` and are retried on a later run. Stay within
  the `apps.telegram` pacing limits (`batchSize`, `dailyCap`, `minIntervalMs`); reduce them if
  `unknown` appears frequently.
- **New or unused accounts** are flagged (`PEER_FLOOD`) much faster. Use the account normally
  for a few days first and run from a residential IP, not a datacenter VPN.
- Telegram's official Gateway `checkSendAbility` API is deliberately not used: its terms
  forbid user enumeration.
