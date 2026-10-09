# WhatsApp setup

The WhatsApp adapter ([`src/adapters/whatsapp.ts`](../src/adapters/whatsapp.ts)) uses [Baileys](https://github.com/WhiskeySockets/Baileys) (v7), an **unofficial** WhatsApp Web client. The tool signs in as a *linked device* of a dedicated WhatsApp account and asks WhatsApp's contact-discovery service which numbers are registered. It never sends messages and never reads chats, profiles, or contacts.

## Risk

WhatsApp does not allow unofficial clients. The checking account can be restricted or banned, and number lookups at volume are exactly what its anti-abuse systems look for. Use a **dedicated SIM/account** that you can afford to lose, never a personal or business-critical number. A fresh account should be used normally for a few days before bulk checking. Keep `dailyCap` / `minIntervalMs` conservative (defaults: 300 numbers/day, ~2 min between batches of 20).

## Log in

```sh
npm run cli -- login whatsapp --account wa1
```

Two ways to link the device (the menu, **2 → WhatsApp**, asks which; no config edit is needed):

1. **Pairing code (recommended; the menu's option 1 and its default).** `npm run cli -- login whatsapp --account wa1 --method code --phone +84901234567` (the menu asks for the number and checks it like a CSV number). The CLI prints an 8-character code such as `ABCD-1234`. On the phone: *Linked devices > Link a device > Link with phone number instead*, then enter the code. `--method qr` forces the QR even when `pairingPhone` is configured; with no `--method`, a configured `pairingPhone` still selects the pairing code (below).
2. **QR code.** Drawn in the terminal with explicit black-on-white colours; a window smaller than about 72 x 39 gets an "enlarge the window / Cmd+minus" message. On the phone: *WhatsApp > Settings > Linked devices > Link a device*, then scan. The first code lasts about 60 s, later ones about 20 s; each new one replaces the last. **Known upstream problem:** since 2026-07-28 WhatsApp sends a `companion_reg_refresh` notification right after a scan and expects a new secret and a redrawn code; Baileys 7.0.0-rc14 ignores it (WhiskeySockets/Baileys#2737, fix proposed in #2765), so the phone showed "check your connection and try again". The adapter now answers it itself (new secret, same code redrawn, "WhatsApp asked for a fresh code after your scan"). This is verified with test doubles and by pty runs up to the QR stage only; it has **not** been confirmed with a phone. If it still fails, use the pairing code.

```json
{
  "apps": {
    "whatsapp": {
      "options": {
        "pairingPhone": "+84901234567",
        "loginTimeoutMs": 180000,
        "connectTimeoutMs": 60000
      }
    }
  }
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `pairingPhone` | unset (QR) | Number of the account being linked, international format. Enables pairing-code login. |
| `loginTimeoutMs` | `180000` | Total time `login` waits for you to scan/enter the code (5 000 - 900 000). |
| `connectTimeoutMs` | `60000` | Time allowed to bring a saved session online when checking (5 000 - 900 000). |

`login` returns only after the device is paired, the connection is open, and credentials are written to disk. WhatsApp ends the first connection right after pairing and the CLI reconnects automatically; this is expected. If nothing is scanned before the timeout, `login` fails with an error and the process exits; nothing keeps running in the background.

Credentials live in the account's session directory under `data/` (`creds.json` plus Signal key files). The directory is mode 700 and the files are set to mode 600 whenever a session is closed (Baileys itself writes them with the default umask, so a crash can leave a file at 644 inside the 700 directory until the next run). Treat them like a password: anyone holding them can act as the linked device. Do not commit `data/`.

## What the checker does

Each batch makes one contact-discovery request (`onWhatsApp`) for all numbers in the batch:

| WhatsApp answer | Status |
| --- | --- |
| number registered | `yes` |
| number not registered | `not_found` |
| answer cannot be attributed to a queried number | `unknown` |

WhatsApp has no setting that hides an account from contact discovery, so `not_found` is reasonably reliable, but it is still a statement about what WhatsApp returned, not proof the person has no account.

Logs never contain full phone numbers or the linked account's own number.

## Failure handling

| Condition | Result |
| --- | --- |
| Logged out (401), forbidden (403), session replaced (440) | `AccountBanned`: the account is disabled until you act. Check the phone; if the device was unlinked or revoked, `login` again re-pairs it (see above). |
| `rate-overlimit` (429) | `RateLimited`: the account cools down for `rateLimitCooldownMs`. |
| Timeouts, dropped connection, empty reply | Temporary error: retried after `errorCooldownMs`. |
| Saved session missing / bad | Error asking you to run `login` again. |

If `login` is interrupted before pairing finishes, the next `login` discards the half-finished state in that account's directory and starts clean. A new account whose first login fails or is interrupted (Ctrl-C, SIGTERM) has its directory removed, so it never shows up as an account.

**Re-login after the device was unlinked or revoked.** Running `login` for an already-linked account first reconnects with the saved credentials. If WhatsApp answers *logged out (401)* (you removed the linked device on the phone, or WhatsApp revoked it), those credentials can never work again: `login` deletes them, says so, and starts a fresh QR / pairing-code flow in the same directory. If WhatsApp answers *session replaced (440)* instead, another client is using the same linked device; the credentials are **kept** and the error names the account directory: close the other client (or a running `check`), then run `login` again, or delete that directory yourself to pair from scratch.

## Maintenance

- WhatsApp changes its protocol often. The adapter asks Baileys for the current WhatsApp Web version at connect time and falls back to the version bundled with the library.
- When lookups start failing after a WhatsApp change, update Baileys: `npm install baileys@latest`, then re-run a small check. Baileys v7 is still a release candidate; pin the version you validated.
- To unlink an account, remove the device on the phone (*Linked devices*) and delete its directory under `data/sessions/whatsapp/`.
