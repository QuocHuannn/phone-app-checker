# LINE adapter setup

The LINE check uses [`@evex/linejs`](https://jsr.io/@evex/linejs), an **unofficial** LINE client. It logs in as a normal LINE account and calls `relation.findContactByPhoneV3` for each number. That call resolves a phone number to a contact without adding a friend, sending a message, or reading a profile. Using it violates LINE's terms, and the account can be restricted or permanently banned. Use a dedicated account on a SIM you can afford to lose, and keep the volume low.

## What the result means

| Report value | Meaning |
|---|---|
| `yes` | LINE returned a contact for this number. Reliable. |
| `not_found` | LINE answered "no such user". **Low confidence** (see below). |
| `unknown` | Lookup returned something unusable. Retried on the next run. |

`not_found` never proves that the number has no LINE account. It also covers users who:

- turned off "Allow others to add me by phone number" (privacy setting),
- registered LINE without a phone number or have since removed it,
- live in a region where LINE no longer supports phone-number search.

### Where phone lookup is meaningful

- LINE only lets users register a phone number in **Hong Kong, Japan, South Korea, Taiwan and Thailand** ([LINE help](https://help.line.me/line/smartphone/sp?contentId=20020049&lang=en)).
- Elsewhere (for example Vietnam, Singapore, Malaysia, Indonesia, Australia, the US) searching by phone number only works for accounts created on a LINE version older than 13.11.0 that still have a registered number ([LINE help](https://help.line.me/line/smartphone/sp?contentId=20000372&lang=en)).

For HK/JP/KR/TW/TH numbers, `yes` and `not_found` are both informative (subject to the privacy setting). For every other country treat `yes` as an observation at that time (not proof of identity or activity) and `not_found` as close to no information.

LINE also temporarily restricts phone search when an account looks up too many numbers. The threshold is not published. The adapter reports this as a rate limit, and the pacing settings then cool the account down.

## Requirements

- Node.js **>= 22.18** (the CLI runs TypeScript directly). Bun and Deno are not supported by this adapter.
- A LINE account, preferably one registered in HK/JP/KR/TW/TH or an old pre-13.11 account, with the LINE app on a phone you can reach during login.
- An interactive terminal for login. Login cannot run from a pipe or CI.
- Network access to `legy.line-apps.com`.

No extra HTTP/2 setup is needed. `@evex/linejs` creates its own `undici` dispatcher on Node, and `undici` is installed with it.

## Login

```sh
npm run cli -- login line --account <name>
```

The QR code is drawn by the same renderer as the other apps (explicit black-on-white colours, readable on dark and light terminal themes; a too-small window gets an "enlarge the window / Cmd+minus" message instead of a broken code). The link behind it is printed above the code, and the instructions follow the menu language.

Two login modes are supported. Pick one in `checker.config.json`:

```json
{
  "apps": {
    "line": {
      "options": {
        "loginMode": "qr",
        "device": "DESKTOPWIN"
      }
    }
  }
}
```

| Option | Values | Default | Notes |
|---|---|---|---|
| `loginMode` | `qr`, `password` | `qr` | `qr` prints a QR code in the terminal. Scan it with the LINE app on the account's phone, then enter the PIN shown in the terminal on the phone. `password` asks for the account e-mail and password (hidden input), then asks for the same PIN confirmation. The account must have an e-mail and password set. |
| `device` | `DESKTOPWIN`, `DESKTOPMAC`, `ANDROIDSECONDARY`, `IOSIPAD` | `DESKTOPWIN` | The client LINE sees. Only secondary-device types are offered, so logging in does not log the phone out. The device is saved and reused by later runs. |

Any other value fails immediately with the list of accepted values.

### Where the session is stored

Everything is stored under the account directory (`data/sessions/line/<name>/`, mode 700):

- `line-auth.json` (mode 600): the access token and device type.
- `line-storage.json` (mode 600): linejs key-value storage (refresh token, expiry, E2EE keys, QR certificate).

The token gives full access to the LINE account. Do not commit `data/`. Profile data (name, status, contacts) is kept in memory only and never written to disk. Phone numbers are masked in logs.

linejs refreshes the access token automatically when a refresh token is stored, and the new token is saved back to `line-auth.json`.

## Error handling

| Situation | Behaviour |
|---|---|
| LINE says the number is unknown | `not_found` |
| Lookup throttled or phone search restricted (`EXCESSIVE_ACCESS`, `EXCEED_DAILY_QUOTA`, `ABUSE_BLOCK`, `FEATURE_RESTRICTED`, `SERVER_BUSY`, `SHOULD_RETRY`, `CONGESTION_CONTROL`) | The adapter stops the batch and reports a rate limit. The account cools down for `rateLimitCooldownMs` (default 24 h) |
| Token expired or revoked, device logged out, account banned, client version rejected | The adapter reports the account as banned and takes it out of rotation. Run `login line --account <name>` again, or upgrade `@evex/linejs` if LINE rejected the client version |
| Anything else | The batch fails with a short error (error code only, no phone number) and the account cools down for `errorCooldownMs` |

If LINE signals a restriction with a code that is not in the table, the adapter falls back to the generic error and cooldown. Report the code in the error message so it can be added.

## Recommended pacing

Defaults in `src/config.ts` are deliberately slow: one number per call, at most 50 numbers per day per account, 2 minutes plus jitter between calls. Raise them only after a pilot run shows no restrictions.

## Verifying a setup

1. Log in with a spare account.
2. Check one number you know has LINE with "Allow others to add me" enabled (ideally a +82, +81, +66, +886 or +852 number). It should come back `yes`.
3. Check a few numbers from your real list and compare against what you know before trusting `not_found`.
